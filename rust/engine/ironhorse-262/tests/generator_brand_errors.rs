//! XS-differential coverage for Generator and AsyncGenerator receiver checks.

use ironhorse_262::{dual_run, dual_run_async, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
}

#[test]
fn generator_methods_throw_for_incompatible_receivers() {
    for method in ["next", "return", "throw"] {
        agrees(&format!(
            "var p=Object.getPrototypeOf(function*(){{}}());\
             try{{p.{method}.call({{}});false}}catch(e){{e instanceof TypeError}}"
        ));
    }
}

#[test]
fn reentrant_generator_resume_throws_a_catchable_type_error() {
    agrees(
        "var it;function* g(){try{it.next();return false}catch(e){return e instanceof TypeError}}\
         it=g();it.next().value",
    );
}

#[test]
fn async_generator_methods_reject_for_incompatible_receivers() {
    let source =
        "var g='';var p=Object.getPrototypeOf(async function*(){}());\
         p.next.call({}).then(undefined,function(e){g+='n'+(e instanceof TypeError)});\
         p.return.call({}).then(undefined,function(e){g+='r'+(e instanceof TypeError)});\
         p.throw.call({}).then(undefined,function(e){g+='t'+(e instanceof TypeError)});undefined";
    let run = dual_run_async(source, "g").expect("the XS oracle machine must start");
    assert_eq!(run.run.agreement, Agreement::BothComplete, "{:?}", run.run);
    assert!(run.run.result_agrees, "{:?}", run.run);
    assert_eq!(run.ironhorse_signal.as_deref(), Some("ntruertruettrue"));
}
