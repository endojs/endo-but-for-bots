//! XS array diagnostics at coercion and callback boundaries.
use ironhorse_262::{dual_run, Agreement};
#[test]
fn array_errors_match_xs_messages() {
    let mut failures = Vec::new();
    for (expression, expected) in [
        (
            "Array.prototype.push.call(null)",
            "TypeError: cannot coerce null to object",
        ),
        (
            "Array.prototype.fill.call(undefined)",
            "TypeError: cannot coerce undefined to object",
        ),
        ("[].map(null)", "TypeError: callback: not a function"),
        ("[].flatMap(null)", "TypeError: callback: not a function"),
        ("[].forEach(null)", "TypeError: callback: not a function"),
        ("[].reduce(function(){})", "TypeError: no initial value"),
        (
            "[].reduceRight(function(){})",
            "TypeError: no initial value",
        ),
        ("[].sort(null)", "TypeError: compare: not a function"),
        ("[].toSorted(null)", "TypeError: compare: not a function"),
        ("[].with(0,1)", "RangeError: invalid index"),
        (
            "Array.prototype.toReversed.call({length:4294967296})",
            "RangeError: array overflow",
        ),
        ("[].at(Object(1n))", "TypeError: cannot coerce to number"),
        (
            "[].fill(1,Symbol())",
            "TypeError: cannot coerce symbol to number",
        ),
        (
            "'x'.lastIndexOf('x',Object(1n))",
            "TypeError: cannot coerce to number",
        ),
        (
            "(function(){var a=[];a.constructor=1;return a.map(function(){})})()",
            "TypeError: invalid constructor",
        ),
        (
            "Uint8Array.prototype.map.call({})",
            "TypeError: this: not a TypedArray instance",
        ),
        (
            "new Uint8Array(0).map(null)",
            "TypeError: callback: not a function",
        ),
        (
            "new Uint8Array(0).reduce(function(){})",
            "TypeError: no initial value",
        ),
        (
            "new Uint8Array(0).sort(null)",
            "TypeError: compare: not a function",
        ),
        (
            "new Uint8Array([2,1]).sort(function(){return Object(1n)})",
            "TypeError: cannot coerce to number",
        ),
("ArrayBuffer.prototype.slice.call({})","TypeError: this: not an ArrayBuffer instance"),
("ArrayBuffer.prototype.transfer.call({})","TypeError: this: not an ArrayBuffer instance"),
("(function(){var b=new ArrayBuffer(2);b.constructor=1;b.slice()})()","TypeError: no constructor"),
("(function(){var b=new ArrayBuffer(2);b.constructor={[Symbol.species]:function(){return b}};b.slice()})()","TypeError: same ArrayBuffer instance"),
("(function(){var b=new ArrayBuffer(2);b.constructor={[Symbol.species]:function(){return new ArrayBuffer(1)}};b.slice()})()","TypeError: smaller ArrayBuffer instance"),
("Uint8Array.from.call({},[])","TypeError: this: not a constructor"),
("Uint8Array.of.call({},1)","TypeError: new: not a constructor"),
("Uint8Array.from([],null)","TypeError: map: not a function"),
("Uint8Array.from(null)","TypeError: cannot coerce null to object"),
("(function(){var a=new Uint8Array(2);a.constructor=1;a.slice()})()","TypeError: no constructor"),
("new Uint8Array(2).fill(1n)","TypeError: cannot coerce to unsigned"),
("new Int8Array(2).fill(Symbol())","TypeError: cannot coerce symbol to integer"),
("new Float32Array(2).fill(1n)","TypeError: cannot coerce to number"),
("new BigInt64Array(2).fill(1)","TypeError: cannot coerce number to bigint"),
("new BigInt64Array(2).fill('x')","SyntaxError: cannot coerce string to bigint"),
("new Uint8Array(2).set([], -1)","RangeError: byteLength < 0"),
("new Uint8Array(2).set([], Infinity)","RangeError: byteLength too big"),
("new Uint8Array(2).set([1,2,3])","RangeError: invalid offset"),
("(new Uint8Array(1))[0]=1n","TypeError: cannot coerce to unsigned"),
("(new Int8Array(1))[0]=Symbol()","TypeError: cannot coerce symbol to integer"),
("(new BigInt64Array(1))[0]='x'","SyntaxError: cannot coerce string to bigint"),
("Uint8Array.from.call(function(){return {}},[])","TypeError: result: not a TypedArray instance"),
("Uint8Array.of.call(function(){return {}},1)","TypeError: this: not a TypedArray instance"),
("Uint8Array.from({[Symbol.iterator]:1})","TypeError: call: not a function"),
("Uint8Array.from({[Symbol.iterator](){return 1}})","TypeError: iterator: not an object"),
("Uint8Array.from({[Symbol.iterator](){return {next(){return 1}}}})","TypeError: iterator result: not an object"),
("Object.getOwnPropertyDescriptor(Iterator.prototype,'constructor').set.call(null,1)","TypeError: set constructor: not an object"),
("Iterator.prototype.constructor=1","TypeError: set constructor: not writable"),
("Object.getOwnPropertyDescriptor(Iterator.prototype,'constructor').set.call(Object.preventExtensions({}),1)","TypeError: set constructor: not extensible"),
("Iterator.prototype[Symbol.toStringTag]='x'","TypeError: set Symbol(toStringTag): not writable"),
("Array.prototype.map.call({length:4294967296}, function(){})", "RangeError: invalid length"),
    ("Uint8Array.prototype.values.call({})","TypeError: this: not a TypedArray instance"),
("Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable').get.call({})","TypeError: this: not an ArrayBuffer instance"),
("Array.prototype.map.call({length:Object(1n)}, function(){})","TypeError: cannot coerce to number"),
] {
        let run = dual_run(expression).expect("oracle starts");
        if run.agreement != Agreement::BothAbort || run.oracle_error != expected || run.ironhorse_error != expected {
            failures.push(format!("{expression}: expected {expected}; {run:?}"));
        }
        let source = format!("try {{ {expression}; 'did not throw' }} catch(e) {{ String(e) }}");
        let run = dual_run(&source).expect("oracle starts");
        if run.agreement != Agreement::BothComplete || run.oracle_result != expected || run.ironhorse_result != expected {
            failures.push(format!("{source}: expected {expected}; {run:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
