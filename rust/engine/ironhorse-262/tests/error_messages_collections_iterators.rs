//! Realm-catchable diagnostics ported from xsMapSet.c and xsGenerator.c.
use ironhorse_262::{dual_run, Agreement};

fn check(expression: &str, expected: &str, constructor: &str) {
    let source = format!("var result='not caught';try {{{expression}}} catch(e){{result=(e instanceof {constructor})+':'+e.message}}result");
    let run = dual_run(&source).unwrap();
    assert_eq!(
        run.oracle_result,
        format!("true:{expected}"),
        "{expression}"
    );
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "{expression}: {run:?}"
    );
    assert_eq!(run.ironhorse_result, run.oracle_result, "{expression}");
}

#[test]
fn collection_brands_and_callbacks() {
    for (kind, method) in [
        ("Map", "set"),
        ("Map", "get"),
        ("Map", "has"),
        ("Map", "delete"),
        ("Map", "clear"),
        ("Map", "entries"),
        ("Map", "keys"),
        ("Map", "values"),
        ("Map", "forEach"),
        ("Set", "add"),
        ("Set", "has"),
        ("Set", "delete"),
        ("Set", "clear"),
        ("Set", "entries"),
        ("Set", "keys"),
        ("Set", "values"),
        ("Set", "forEach"),
        ("WeakMap", "set"),
        ("WeakMap", "get"),
        ("WeakMap", "has"),
        ("WeakMap", "delete"),
        ("WeakSet", "add"),
        ("WeakSet", "has"),
        ("WeakSet", "delete"),
    ] {
        for receiver in [
            "{}",
            "1",
            if kind == "Map" {
                "new Set()"
            } else {
                "new Map()"
            },
        ] {
            if kind == "Map" && receiver == "new Map()" {
                continue;
            }
            check(
                &format!("{kind}.prototype.{method}.call({receiver})"),
                &format!("this: not a {kind} instance"),
                "TypeError",
            );
        }
    }
    for kind in ["Map", "Set"] {
        check(
            &format!("new {kind}().forEach(1)"),
            "callback: not a function",
            "TypeError",
        );
    }
    check("new WeakMap().set(1,2)", "key: not an object", "TypeError");
    check("new WeakSet().add(1)", "value: not an object", "TypeError");
}

#[test]
fn set_records() {
    for (expression, message, constructor) in [
        (
            "Set.prototype.union.call({},{})",
            "this: not a Set instance",
            "TypeError",
        ),
        ("new Set().union(1)", "other is no object", "TypeError"),
        (
            "new Set().union({size:NaN})",
            "other.size is NaN",
            "TypeError",
        ),
        ("new Set().union({size:-1})", "other.size < 0", "RangeError"),
        (
            "new Set().union({size:0,has:1})",
            "other.has is no function",
            "TypeError",
        ),
        (
            "new Set().union({size:0,has(){},keys:1})",
            "other.keys is no function",
            "TypeError",
        ),
        (
            "new Set().union({size:0,has(){},keys(){return {next(){return 1}}}})",
            "iterator result: not an object",
            "TypeError",
        ),
    ] {
        check(expression, message, constructor);
    }
}

#[test]
fn iterator_errors() {
    for (expression,message) in [
        ("Iterator.from(1)","iterator: not a string"),
        ("Iterator.from({[Symbol.iterator]:1})","call: not a function"),
        ("Iterator.from({[Symbol.iterator](){return 1}})","iterator: not an object"),
        ("Object.getPrototypeOf(Iterator.from({next(){}})).next.call({})","this: not an iterator"),
        ("Object.getPrototypeOf(Iterator.from({next(){}})).return.call({})","this: not an iterator"),
        ("Iterator.from({return:1}).return()","call: not a function"),
        ("Iterator.prototype.toArray.call(1)","this: not an object"),
        ("Iterator.prototype.reduce.call({},1)","reducer: not a function"),
        ("Iterator.prototype.forEach.call({},1)","procedure: not a function"),
        ("Iterator.prototype.some.call({},1)","predicate: not a function"),
        ("Iterator.prototype.every.call({},1)","predicate: not a function"),
        ("Iterator.prototype.find.call({},1)","predicate: not a function"),
        ("Iterator.prototype.toArray.call({next:1})","call: not a function"),
        ("Iterator.prototype.toArray.call({next(){return 1}})","iterator result: not an object"),
        ("Iterator.prototype.reduce.call({next(){return {done:true}}},function(){})","no initial value"),
        ("Iterator.prototype.some.call({next(){return {done:false,value:1}},return:1},function(){return true})","call: not a function"),
        ("Iterator.prototype.some.call({next(){return {done:false,value:1}},return(){return 1}},function(){return true})","iterator result: not an object"),
    ] {check(expression,message,"TypeError");}
}

#[test]
fn collection_constructors_and_grouping() {
    for kind in ["Map", "Set", "WeakMap", "WeakSet"] {
        let adder = if kind.ends_with("Map") { "set" } else { "add" };
        check(
            &format!("{kind}.prototype.{adder}=1;new {kind}([])"),
            &format!("result.{adder}: not a function"),
            "TypeError",
        );
        check(
            &format!("new {kind}(1)"),
            "call: not a function",
            "TypeError",
        );
        check(
            &format!("new {kind}({{[Symbol.iterator](){{return 1}}}})"),
            "iterator: not an object",
            "TypeError",
        );
        check(
            &format!("new {kind}({{[Symbol.iterator](){{return {{next:1}}}}}})"),
            "call: not a function",
            "TypeError",
        );
        check(
            &format!("new {kind}({{[Symbol.iterator](){{return {{next(){{return 1}}}}}}}})"),
            "iterator result: not an object",
            "TypeError",
        );
    }
    for kind in ["Map", "WeakMap"] {
        check(
            &format!("new {kind}([1])"),
            "item: not an object",
            "TypeError",
        );
        for method in ["getOrInsert", "getOrInsertComputed"] {
            check(
                &format!("{kind}.prototype.{method}.call({{}},1)"),
                &format!("this: not a {kind} instance"),
                "TypeError",
            );
        }
    }
    check("new WeakMap([[1,2]])", "key: not an object", "TypeError");
    check("new WeakSet([1])", "value: not an object", "TypeError");
    check(
        "new Map().getOrInsertComputed(1,2)",
        "callback: not a function",
        "TypeError",
    );
    check(
        "new WeakMap().getOrInsert(1,2)",
        "key: not an object",
        "TypeError",
    );
    check(
        "new WeakMap().getOrInsertComputed({},2)",
        "callback: not a function",
        "TypeError",
    );
    for kind in ["Map", "Object"] {
        check(
            &format!("{kind}.groupBy()"),
            "items: not an object",
            "TypeError",
        );
        check(
            &format!("{kind}.groupBy([],undefined)"),
            "items: not an object",
            "TypeError",
        );
        check(
            &format!("{kind}.groupBy([],1)"),
            "callback: not a function",
            "TypeError",
        );
        check(
            &format!("{kind}.groupBy(null,function(){{}})"),
            "cannot coerce null to object",
            "TypeError",
        );
        check(
            &format!("{kind}.groupBy({{}},function(){{}})"),
            "call: not a function",
            "TypeError",
        );
        check(
            &format!("{kind}.groupBy({{[Symbol.iterator](){{return 1}}}},function(){{}})"),
            "iterator: not an object",
            "TypeError",
        );
    }
}

#[test]
fn iterator_native_brand_errors() {
    for iterator in [
        "[][Symbol.iterator]()",
        "new Map().keys()",
        "new Set().values()",
    ] {
        check(
            &format!("Object.getPrototypeOf({iterator}).next.call({{}})"),
            "this: not an iterator",
            "TypeError",
        );
    }
}

#[test]
fn aggregate_error_iterator_failures_and_detached_array_iterator() {
    for (expression, message) in [
        ("new AggregateError(null)", "cannot coerce null to object"),
        (
            "new AggregateError(undefined)",
            "cannot coerce undefined to object",
        ),
        ("new AggregateError(1)", "call: not a function"),
        (
            "new AggregateError({[Symbol.iterator](){return 1}})",
            "iterator: not an object",
        ),
        (
            "new AggregateError({[Symbol.iterator](){return {next:1}}})",
            "call: not a function",
        ),
        (
            "new AggregateError({[Symbol.iterator](){return {next(){return 1}}}})",
            "iterator result: not an object",
        ),
        (
            "var a=new Uint8Array(1);var i=a.values();a.buffer.transfer();i.next()",
            "out of bound buffer",
        ),
    ] {
        check(expression, message, "TypeError");
    }
}

#[test]
fn set_keys_nullish_result_and_group_by_primitive_diagnostics() {
    for value in ["null", "undefined"] {
        let expression = format!("new Set().union({{size:0,has(){{}},keys(){{return {value}}}}})");
        let message = format!("cannot coerce {value} to object");
        check(&expression, &message, "TypeError");
        let run = dual_run(&expression).unwrap();
        assert_eq!(run.agreement, Agreement::BothAbort, "{run:?}");
        assert_eq!(run.oracle_error, format!("TypeError: {message}"));
        assert_eq!(run.ironhorse_error, run.oracle_error);
    }
    for constructor in ["Object", "Map"] {
        for value in ["1", "true", "1n", "Symbol()"] {
            check(
                &format!("{constructor}.groupBy({value},()=>1)"),
                "call: not a function",
                "TypeError",
            );
        }
    }
}
