//! Exact XS errors for array metadata, computed stores and integrity operations.
use ironhorse_262::{dual_run, Agreement};
#[test]
fn integrity_errors_match_xs_messages() {
    let mut failures = Vec::new();
    for (expression,expected) in [
("(function(){'use strict';var a=Object.freeze([1]);a[0]=2})()","TypeError: set ?: not writable"),
("(function(){'use strict';var a=Object.preventExtensions([]);a[0]=2})()","TypeError: set ?: not extensible"),
("(function(){'use strict';var a=[];Object.defineProperty(a,'length',{writable:false});a[0]=2})()","TypeError: set ?: not extensible"),
("(function(){'use strict';var a=Object.freeze([]);var k='length';a[k]=0})()","TypeError: set length: not writable"),
("Object.defineProperty([], 'length', {value:-1})","RangeError: invalid length"),
("Object.defineProperty([], 'length', {value:Object(1n)})","TypeError: cannot coerce to unsigned"),
("Object.defineProperty([], 'length', {value:Symbol()})","TypeError: cannot coerce symbol to unsigned"),
("harden(new Proxy({}, {preventExtensions(){return false}}))","TypeError: extensible object"),
("petrify(new Proxy({}, {preventExtensions(){return false}}))","TypeError: extensible object"),
("harden(new Proxy({x:1}, {defineProperty(){return false}}))","TypeError: cannot configure property"),
("petrify(new Proxy({x:1}, {defineProperty(){return false}}))","TypeError: cannot configure property"),
] {
 let run=dual_run(expression).expect("oracle starts");
 if run.agreement != Agreement::BothAbort || run.oracle_error != expected || run.ironhorse_error != expected { failures.push(format!("{expression}: expected {expected}; {run:?}")); }
 let source=format!("try {{ {expression}; 'did not throw' }} catch(e) {{ String(e) }}");
 let run=dual_run(&source).expect("oracle starts");
 if run.agreement != Agreement::BothComplete || run.oracle_result != expected || run.ironhorse_result != expected { failures.push(format!("{source}: expected {expected}; {run:?}")); }
 }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
