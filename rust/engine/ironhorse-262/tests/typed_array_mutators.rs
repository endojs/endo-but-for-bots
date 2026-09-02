//! Oracle-backed regressions for the in-place TypedArray mutators.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
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
fn copy_within_coerces_indices_and_snapshots_overlap() {
    assert_result_agrees("var a=new Uint8Array([1,2,3,4]); a.copyWithin(1,0,3); a[0]+','+a[1]+','+a[2]+','+a[3]");
    assert_result_agrees("var a=new Uint8Array([1,2,3,4]); a.copyWithin(0,1,4); a[0]+','+a[1]+','+a[2]+','+a[3]");
    assert_result_agrees("var a=new Uint8Array([1,2,3,4]); a.copyWithin('-2', true); a[0]+','+a[1]+','+a[2]+','+a[3]");
    assert_result_agrees("var a=new Uint8Array([1,2,3]); var n=0; a.copyWithin({valueOf:function(){n++;return 1}},0,2); a[0]+','+a[1]+','+a[2]+':'+n");
}

#[test]
fn fill_coerces_once_and_respects_element_domain() {
    assert_result_agrees("var a=new Int8Array(4); var n=0; a.fill({valueOf:function(){n++;return '258'}},1,3); a[0]+','+a[1]+','+a[2]+','+a[3]+':'+n");
    assert_result_agrees("var a=new BigInt64Array(3); a.fill('7',-2); a[0]===0n && a[1]===7n && a[2]===7n");
    assert_result_agrees("var a=new Uint8Array(1); try { a.fill(1n); false } catch(e) { e instanceof TypeError }");
    assert_result_agrees("var a=new BigInt64Array(1); try { a.fill(1); false } catch(e) { e instanceof TypeError }");
    assert_result_agrees("var a=new BigInt64Array(3); var n=1n; a.fill({valueOf:function(){return n++}}); n+':'+a[0]+':'+a[1]+':'+a[2]");
}

#[test]
fn set_handles_typed_array_array_like_overlap_and_domain_mismatch() {
    assert_result_agrees("var b=new ArrayBuffer(4); var a=new Uint8Array(b); a.set([1,2,3,4]); var s=new Uint8Array(b,0,3); a.set(s,1); a[0]+','+a[1]+','+a[2]+','+a[3]");
    assert_result_agrees("var a=new Int16Array(4); a.set({0:'257',1:true,length:2},1); a[0]+','+a[1]+','+a[2]+','+a[3]");
    assert_result_agrees("var a=new Uint8Array(3); a.set('42',1); a[0]+','+a[1]+','+a[2]");
    assert_result_agrees("var a=new Uint8Array(1); a.set(true); a[0]");
    assert_result_agrees("var a=new Uint8Array(3); a.set(new Int16Array([257,-1]),1); a[0]+','+a[1]+','+a[2]");
    assert_result_agrees("var a=new Uint8Array(1); try { a.set(new BigInt64Array(1)); false } catch(e) { e instanceof TypeError }");
    assert_result_agrees("var a=new BigInt64Array(1); try { a.set(new Int8Array(1)); false } catch(e) { e instanceof TypeError }");
    assert_result_agrees("var a=new Uint8Array(1); try { a.set([1],-1); false } catch(e) { e instanceof RangeError }");
}

#[test]
fn reverse_swaps_raw_elements_for_number_and_bigint_views() {
    assert_result_agrees("var a=new Float64Array([1,-0,NaN]); a.reverse(); String(a[0])+':'+(1/a[1])+':'+a[2]");
    assert_result_agrees("var a=new BigInt64Array([1n,-2n,3n]); a.reverse(); a[0]===3n && a[1]===-2n && a[2]===1n");
}

#[test]
fn receiver_and_detached_buffer_validation_throw_type_error() {
    for method in ["copyWithin(0,0)", "fill(1)", "set([])", "reverse()"] {
        assert_result_agrees(&format!(
            "try {{ Uint8Array.prototype.{method}.call({{}}); false }} catch(e) {{ e instanceof TypeError }}"
        ));
    }
    for method in ["copyWithin(0,0)", "fill(1)", "set([])", "reverse()"] {
        assert_result_agrees(&format!(
            "var a=new Uint8Array(2); $262.detachArrayBuffer(a.buffer); try {{ a.{method}; false }} catch(e) {{ e instanceof TypeError }}"
        ));
    }
}

#[test]
fn detachment_during_coercion_or_array_like_get_throws() {
    assert_result_agrees("var a=new Uint8Array(2); var x={valueOf:function(){$262.detachArrayBuffer(a.buffer);return 0}}; try { a.copyWithin(x,0); false } catch(e) { e instanceof TypeError }");
    assert_result_agrees("var a=new Uint8Array(2); var x={valueOf:function(){$262.detachArrayBuffer(a.buffer);return 1}}; try { a.fill(x); false } catch(e) { e instanceof TypeError }");
    assert_result_agrees("var a=new Uint8Array(2); var x={valueOf:function(){$262.detachArrayBuffer(a.buffer);return 0}}; try { a.set([],x); false } catch(e) { e instanceof TypeError }");
}

#[test]
fn set_checks_detachment_after_each_array_like_get() {
    let source = "var a=new Uint8Array([1,2,3]); var x={length:3,0:42}; Object.defineProperty(x,1,{get:function(){$262.detachArrayBuffer(a.buffer)}}); Object.defineProperty(x,2,{get:function(){throw Error('late read')}}); try { a.set(x); false } catch(e) { e instanceof TypeError }";
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
    assert_eq!(
        run.oracle_result, "false",
        "pinned XS defect changed: {run:?}"
    );
    assert_eq!(
        run.ironhorse_result, "true",
        "IronHorse must follow SetTypedArrayFromArrayLike detachment order: {run:?}"
    );
}
