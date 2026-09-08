//! Exact pinned XS diagnostics for RegExp protocol and String split failures.
use ironhorse_262::{dual_run, Agreement};
#[test]
fn regexp_errors_match_xs_messages() {
    let mut failures = Vec::new();
    for (expression,expected) in [
("new RegExp('(', '')","SyntaxError: invalid regular expression: ( invalid sequence"),
("new RegExp('x', 'gg')","SyntaxError: invalid regular expression:  invalid flags"),
("new RegExp('[', '')","SyntaxError: invalid regular expression: [ invalid range"),
("RegExp.prototype[Symbol.matchAll].call(null, 'x')","TypeError: this: not an object"),
("RegExp.prototype[Symbol.split].call(null, 'x')","TypeError: this: not an object"),
("RegExp.prototype[Symbol.match].call(null, 'x')","TypeError: cannot coerce null to object"),
("RegExp.prototype[Symbol.search].call(undefined, 'x')","TypeError: cannot coerce undefined to object"),
("RegExp.prototype.test.call({exec(){return 1}},'x')","TypeError: invalid exec result"),
("RegExp.prototype.test.call({},'x')","TypeError: this: not a RegExp instance"),
("(function(){var r=/x/;r.constructor=1;return r[Symbol.split]('x')})()","TypeError: no constructor"),
("'x'.matchAll(/x/)","TypeError: regexp has no g flag"),
("String.prototype.matchAll.call(null,/x/g)","TypeError: this: null"),
("String.prototype.split.call(undefined, 'x')","TypeError: this: undefined"),
("'x'.split('x',Object(1n))","TypeError: cannot coerce to unsigned"),
("'x'.split(/x/,Symbol())","TypeError: cannot coerce symbol to unsigned"),
("RegExp.prototype.exec.call(Object.freeze(/x/g),'x')","TypeError: C: xsSet lastIndex: not writable"),
("Object.getPrototypeOf(/x/g[Symbol.matchAll]('x')).next.call({})","TypeError: this: not an iterator"),
("new RegExp('\\\\2','u')","SyntaxError: invalid regular expression: \\2 invalid reference number \\2"),
("new RegExp('(?<a>x)\\\\k<b>','u')","SyntaxError: invalid regular expression: (?<a>x)\\k<b> invalid reference name \\k<b>"),
("new RegExp('x'.repeat(100)+'[')","SyntaxError: invalid regular expression: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx[ invalid range"),
("RegExp.prototype[Symbol.matchAll].call({constructor:{[Symbol.species]:function(){return Object.freeze({})}},flags:'g'},'x')","TypeError: C: xsSet lastIndex: not extensible"),
("new RegExp('(?ii:a)')", "SyntaxError: invalid regular expression: (?ii invalid modifiers"),
("new RegExp('(?i-i:a)')", "SyntaxError: invalid regular expression: (?i-i: invalid modifiers"),
("RegExp.prototype.exec.call(null, 'x')","TypeError: this: not a RegExp instance"),
("RegExp.prototype.exec.call({}, 'x')","TypeError: this: not a RegExp instance"),
("RegExp.prototype.test.call(null, 'x')","TypeError: cannot coerce null to object"),
("RegExp.prototype[Symbol.replace].call(undefined, 'x')","TypeError: cannot coerce undefined to object"),
("RegExp.prototype.toString.call(null)","TypeError: cannot coerce null to object"),
("String.prototype.match.call(undefined, /x/)","TypeError: this: undefined"),
("String.prototype.search.call(null, /x/)","TypeError: this: null"),
("String.prototype.replace.call(undefined, /x/, '')","TypeError: this: undefined"),
("'x'.replaceAll(/x/, '')","TypeError: regexp has no g flag"),
] {
 let run=dual_run(expression).expect("oracle starts");
 if run.agreement != Agreement::BothAbort || run.oracle_error != expected || run.ironhorse_error != expected { failures.push(format!("{expression}: expected {expected}; {run:?}")); }
 let source=format!("try {{ {expression}; 'did not throw' }} catch(e) {{ String(e) }}");
 let run=dual_run(&source).expect("oracle starts");
 if run.agreement != Agreement::BothComplete || run.oracle_result != expected || run.ironhorse_result != expected { failures.push(format!("{source}: expected {expected}; {run:?}")); }
 }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
