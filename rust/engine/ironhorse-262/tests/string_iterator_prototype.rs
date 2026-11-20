//! Oracle-backed coverage for `%StringIteratorPrototype%`, a boot object of
//! its own rather than a share of `%ArrayIteratorPrototype%`: each carries
//! its own `next`, branded on its own iterator kind, and its own
//! `Symbol.toStringTag` (`String Iterator` and `Array Iterator`).

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
fn prototypes_are_distinct_and_chain_to_iterator_prototype() {
    for source in [
        "var S=Object.getPrototypeOf(''[Symbol.iterator]()), A=Object.getPrototypeOf([][Symbol.iterator]()); [S!==A, Object.getPrototypeOf(S)===Iterator.prototype, Object.getPrototypeOf(A)===Iterator.prototype, S.next!==A.next].join()",
        "var S=Object.getPrototypeOf(''[Symbol.iterator]()); Reflect.ownKeys(S).map(String).join()",
        "var A=Object.getPrototypeOf([][Symbol.iterator]()); Reflect.ownKeys(A).map(String).join()",
        "var S=Object.getPrototypeOf(''[Symbol.iterator]()); var d=Object.getOwnPropertyDescriptor(S,'next'); [typeof d.value, d.value.name, d.value.length, d.writable, d.enumerable].join()",
    ] {
        agrees(source);
    }
}

#[test]
fn to_string_tags_name_each_iterator() {
    for source in [
        "var ts=Object.prototype.toString; [ts.call([][Symbol.iterator]()), ts.call([].keys()), ts.call(new Uint8Array(1).values()), ts.call(''[Symbol.iterator]())].join()",
        "['Array','String'].map(function(k){var p=Object.getPrototypeOf(k==='Array'?[][Symbol.iterator]():''[Symbol.iterator]()); var d=Object.getOwnPropertyDescriptor(p,Symbol.toStringTag); return [d.value,d.writable,d.enumerable,d.configurable].join(':')}).join()",
    ] {
        agrees(source);
    }
}

#[test]
fn next_methods_reject_the_other_iterator_kind() {
    for source in [
        "var S=Object.getPrototypeOf(''[Symbol.iterator]()), A=Object.getPrototypeOf([][Symbol.iterator]()); [[S,[1][Symbol.iterator]()],[A,'x'[Symbol.iterator]()],[S,new Map().keys()],[S,{}]].map(function(p){try{p[0].next.call(p[1]);return 'ok'}catch(e){return e.constructor.name}}).join()",
        "var it='a\\u{1F600}b'[Symbol.iterator](); var o=[]; for (var r=it.next(); !r.done; r=it.next()) o.push(r.value.length); o.join()",
        "[...'xy'].join() + ':' + Array.from('\\u{1F600}z').length + ':' + Iterator.from('pq').toArray().join()",
    ] {
        agrees(source);
    }
}
