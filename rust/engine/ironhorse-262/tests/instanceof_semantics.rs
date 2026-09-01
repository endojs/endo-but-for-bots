//! `instanceof` and `Function.prototype[Symbol.hasInstance]` conformance.

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
fn right_operand_must_be_an_object_with_a_callable_handler_or_be_callable() {
    agrees("var ok=false; try { 0 instanceof 1 } catch (e) { ok=e instanceof TypeError } ok");
    agrees("var ok=false; try { 0 instanceof {} } catch (e) { ok=e instanceof TypeError } ok");
    agrees("var o={}; o[Symbol.hasInstance]=null; var ok=false; try { 0 instanceof o } catch (e) { ok=e instanceof TypeError } ok");
    agrees("var o={}; o[Symbol.hasInstance]=1; var ok=false; try { 0 instanceof o } catch (e) { ok=e instanceof TypeError } ok");
}

#[test]
fn custom_has_instance_observes_receiver_argument_and_truthiness() {
    agrees("var c=0,t,a; var o={ [Symbol.hasInstance]:function(v){c++;t=this;a=v;return 'yes'} }; var x={}; ''+(x instanceof o)+':' + (c===1)+':' + (t===o)+':' + (a===x)");
    agrees("var o={ [Symbol.hasInstance]:function(){return 0} }; 1 instanceof o");
}

#[test]
fn custom_has_instance_getter_abrupt_completion_is_catchable() {
    agrees("var marker={}; var o=Object.defineProperty({},Symbol.hasInstance,{get:function(){throw marker}}); var ok=false; try { 0 instanceof o } catch(e){ok=e===marker} ok");
}

#[test]
fn ordinary_has_instance_observes_prototype_access_and_short_circuits_primitives() {
    agrees("var hit=0; Object.defineProperty(Function.prototype,'prototype',{get:function(){hit++;return Array.prototype}}); ''+([] instanceof Function.prototype)+':'+hit");
    agrees("Object.defineProperty(Function.prototype,'prototype',{get:function(){throw 1}}); 0 instanceof Function.prototype");
    agrees("Function.prototype.prototype='bad'; var ok=false; try { [] instanceof Function.prototype } catch(e){ok=e instanceof TypeError} ok");
}

#[test]
fn bound_functions_and_proxy_prototype_walks_follow_the_mop() {
    agrees("function F(){}; var B=F.bind(null); new F() instanceof B");
    agrees("var proto={}; function F(){} F.prototype=proto; var p=new Proxy({}, {getPrototypeOf:function(){return proto}}); p instanceof F");
}

#[test]
fn function_has_instance_intrinsic_has_the_spec_surface_and_is_directly_callable() {
    agrees("var m=Function.prototype[Symbol.hasInstance]; ''+m.name+':'+m.length+':'+m.call(Array,[])+':'+m.call({}, {})");
    agrees("var d=Object.getOwnPropertyDescriptor(Function.prototype,Symbol.hasInstance); ''+d.writable+':'+d.enumerable+':'+d.configurable");
}
