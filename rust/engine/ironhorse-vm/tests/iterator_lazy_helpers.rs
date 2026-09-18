//! The five lazy Iterator helpers (`map`, `filter`, `take`, `drop`,
//! `flatMap`), which until now were advertised on `%Iterator.prototype%` and
//! then halted the machine with `NotImplemented("Iterator.helper")` — a halt
//! guest code cannot catch, so the SES prologue deleted them rather than risk
//! one.
//!
//! Every expectation below was taken from Node 22 first and then asserted
//! here, the generated-matrix-versus-Node method. Two cases deliberately
//! diverge from Node 22 and are marked inline: when an argument fault (a
//! non-callable mapper, a negative or NaN count) aborts helper CREATION, the
//! receiver is closed — its `return` runs. That is the ES2025 ordering, which
//! builds the incomplete iterator record BEFORE validating the argument, and
//! it is what the eager helpers beside these already implement
//! (`iterator_terminal_helper_inner`). Node 22 predates the change and does
//! not close. Matching Node here would split the two helper families in the
//! same file; the vendored test262 snapshot predates Iterator helpers
//! entirely and cannot arbitrate.
//!
//! Note the distinction the matrix pins between those cases and case 43: a
//! THROWING `next` GETTER is reached by a plain `?` after the argument checks
//! have had their chance, so it propagates WITHOUT closing. Node agrees there,
//! and so does this engine.

use ironhorse_compile::compile_atoms;
use ironhorse_vm::{parse_symbols_checked, Interp};

fn run(source: &str) -> String {
    let (bytecode, symbols) = compile_atoms(source).expect("probe compiles");
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols_checked(&symbols).unwrap());
    let out = vm.run(&bytecode);
    assert!(out.completed, "{source}: {:?}", out.halt);
    out.result
}

#[test]
fn lazy_helpers_match_the_generated_node_matrix() {
    for (probe, expected) in [
        (
            r#"(()=>{try{return String([...[1,2,3].values().map(x=>x*2)])}catch(e){return e.constructor.name}})()"#,
            "2,4,6",
        ),
        (
            r#"(()=>{try{return String([...[1,2,3].values().filter(x=>x>1)])}catch(e){return e.constructor.name}})()"#,
            "2,3",
        ),
        (
            r#"(()=>{try{return String([...[1,2,3].values().take(2)])}catch(e){return e.constructor.name}})()"#,
            "1,2",
        ),
        (
            r#"(()=>{try{return String([...[1,2,3].values().drop(1)])}catch(e){return e.constructor.name}})()"#,
            "2,3",
        ),
        (
            r#"(()=>{try{return String([...[1,2].values().flatMap(x=>[x,x])])}catch(e){return e.constructor.name}})()"#,
            "1,1,2,2",
        ),
        (
            r#"(()=>{try{[1].values().map(1)}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{try{[1].values().filter(null)}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{try{[1].values().flatMap(undefined)}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{try{[1].values().take(-1)}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "RangeError",
        ),
        (
            r#"(()=>{try{[1].values().take(NaN)}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "RangeError",
        ),
        (
            r#"(()=>{try{[1].values().drop(-1)}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "RangeError",
        ),
        (
            r#"(()=>{try{[1].values().drop(NaN)}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "RangeError",
        ),
        (
            r#"(()=>{try{return String([...[1,2,3].values().take(-0.5)])}catch(e){return e.constructor.name}})()"#,
            "",
        ),
        (
            r#"(()=>{try{return String([...[1,2,3].values().drop(-0.5)])}catch(e){return e.constructor.name}})()"#,
            "1,2,3",
        ),
        (
            r#"(()=>{try{return String([...[1,2,3].values().take(1.9)])}catch(e){return e.constructor.name}})()"#,
            "1",
        ),
        (
            r#"(()=>{try{return String([...[1,2,3].values().take('2')])}catch(e){return e.constructor.name}})()"#,
            "1,2",
        ),
        (
            r#"(()=>{try{[1].values().take(Symbol())}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{try{[1].values().take({valueOf(){throw new RangeError('x')}})}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "RangeError",
        ),
        // Node 22 answers '0': it predates the ES2025 close-on-early-error
        // ordering. See the module note.
        (
            r#"(()=>{let c=0;const it={next(){return{value:1,done:false}},return(){c++;return{}},[Symbol.iterator](){return this}};try{Iterator.prototype.map.call(it,1)}catch(e){}return String(c)})()"#,
            "1",
        ),
        // Node 22 answers '0': it predates the ES2025 close-on-early-error
        // ordering. See the module note.
        (
            r#"(()=>{let c=0;const it={next(){return{value:1,done:false}},return(){c++;return{}},[Symbol.iterator](){return this}};try{Iterator.prototype.take.call(it,-1)}catch(e){}return String(c)})()"#,
            "1",
        ),
        (
            r#"(()=>{let c=0;const it={next(){return{value:1,done:false}},return(){c++;return{}},[Symbol.iterator](){return this}};const h=Iterator.prototype.map.call(it,x=>{throw new TypeError('boom')});try{h.next()}catch(e){return e.constructor.name+':'+c}return 'no throw'})()"#,
            "TypeError:1",
        ),
        (
            r#"(()=>{let c=0;const it={next(){return{value:1,done:false}},return(){c++;return{}},[Symbol.iterator](){return this}};const h=Iterator.prototype.take.call(it,1);h.next();const r=h.next();return String(c)+':'+String(r.done)})()"#,
            "1:true",
        ),
        (
            r#"(()=>{const it=[1,2,3].values();const h=it.map(x=>x);h.next();h.return();return String(h.next().done)})()"#,
            "true",
        ),
        (
            r#"(()=>{const it=[1,2,3].values();const h=it.map(x=>x);const r=h.return();return String(r.value)+':'+String(r.done)})()"#,
            "undefined:true",
        ),
        (
            r#"(()=>{const h=[1,2,3].values().map(x=>x);h.next();h.next();h.next();return String(h.next().done)})()"#,
            "true",
        ),
        (
            r#"(()=>{let seen=[];const h=[10,20].values().map((x,i)=>{seen.push(i);return x});[...h];return seen.join(',')})()"#,
            "0,1",
        ),
        (
            r#"(()=>{let seen=[];const h=[10,20].values().filter((x,i)=>{seen.push(i);return true});[...h];return seen.join(',')})()"#,
            "0,1",
        ),
        (
            r#"(()=>{let seen=[];const h=[10,20].values().flatMap((x,i)=>{seen.push(i);return [x]});[...h];return seen.join(',')})()"#,
            "0,1",
        ),
        (
            r#"(()=>{const it={i:0,next(){return this.i<2?{value:++this.i,done:false}:{value:undefined,done:true}},[Symbol.iterator](){return this}};const h=Iterator.prototype.map.call(it,x=>x);it.next=()=>({value:99,done:false});return String([...h].slice(0,3))})()"#,
            "1,2",
        ),
        (
            r#"(()=>{try{return String([...[1,2].values().flatMap(x=>'ab')])}catch(e){return e.constructor.name}})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{try{return String([...[1].values().flatMap(x=>1)])}catch(e){return e.constructor.name}})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{try{return String([...[1].values().flatMap(x=>({[Symbol.iterator](){return [7,8].values()}}))])}catch(e){return e.constructor.name}})()"#,
            "7,8",
        ),
        (
            r#"(()=>{try{return String([...[1].values().flatMap(x=>({next(){return{done:true}}}))])}catch(e){return e.constructor.name}})()"#,
            "",
        ),
        (
            r#"(()=>{try{return String([...[1].values().flatMap(x=>({[Symbol.iterator]:1}))])}catch(e){return e.constructor.name}})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{const h=[1,2].values().map(x=>x);return String(Object.getPrototypeOf(Object.getPrototypeOf(h))===Iterator.prototype)})()"#,
            "true",
        ),
        (
            r#"(()=>{const a=[1,2].values().map(x=>x);const b=[1,2].values().filter(x=>x);return String(Object.getPrototypeOf(a)===Object.getPrototypeOf(b))})()"#,
            "true",
        ),
        (
            r#"(()=>{try{Iterator.prototype.map.call({},x=>x)}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "no throw",
        ),
        (
            r#"(()=>{try{Iterator.prototype.map.call(1,x=>x)}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{try{const h=[1].values().map(x=>x);Object.getPrototypeOf(h).next.call({})}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{let h;h=[1,2,3].values().map(x=>{try{h.next()}catch(e){return e.constructor.name}return 'no throw'});return String(h.next().value)})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{const it={next(){throw new RangeError('n')},[Symbol.iterator](){return this}};const h=Iterator.prototype.map.call(it,x=>x);try{h.next()}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "RangeError",
        ),
        (
            r#"(()=>{const it={next(){return 1},[Symbol.iterator](){return this}};const h=Iterator.prototype.map.call(it,x=>x);try{h.next()}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{try{const it={get next(){throw new RangeError('g')},[Symbol.iterator](){return this}};Iterator.prototype.map.call(it,x=>x)}catch(e){return e.constructor.name}return 'no throw'})()"#,
            "RangeError",
        ),
        (
            r#"(()=>{let c=0;const it={get next(){throw new RangeError('g')},return(){c++;return{}},[Symbol.iterator](){return this}};try{Iterator.prototype.map.call(it,x=>x)}catch(e){}return String(c)})()"#,
            "0",
        ),
        (
            r#"(()=>{const h=[1,2,3].values().take(2);h.next();h.next();const r=h.next();return String(r.done)+':'+String(r.value)})()"#,
            "true:undefined",
        ),
        (
            r#"(()=>{const h=[1,2,3].values().drop(1);return String([...h])})()"#,
            "2,3",
        ),
        (
            r#"(()=>{const h=[1,2,3].values().drop(0);return String([...h])})()"#,
            "1,2,3",
        ),
        (
            r#"(()=>{const h=[1,2,3].values().take(0);return String([...h].length)})()"#,
            "0",
        ),
        (
            r#"(()=>{const h=[1,2,3].values().map(x=>x).drop(1).take(1);return String([...h])})()"#,
            "2",
        ),
        (
            r#"(()=>{const h=[[1,2],[3]].values().flatMap(x=>x);return String([...h])})()"#,
            "1,2,3",
        ),
        (
            r#"(()=>{const h=[1,2,3].values();const t=h.take(2);t.next();return String(h.next().value)})()"#,
            "2",
        ),
        // A collection cursor's `next` must REFUSE a lazy helper receiver.
        // A helper can be built straight over a Map or Set, so its row carries
        // a collection in `iterable`; branding on that alone let
        // `%MapIteratorPrototype%.next.call(helper)` run the collection-cursor
        // path over the helper's PRIVATE holder and hand it back — the
        // captured `next` and the guest callback, readable and writable
        // through an ordinary Array. Found by an adversarial review; Node 22
        // rejects both of these the same way.
        (
            r#"(()=>{var m=new Map();m.set("k",1);var h=Iterator.prototype.map.call(m,function(v){return v});var mnext=Object.getPrototypeOf(m.keys()).next;try{mnext.call(h)}catch(e){return e.constructor.name}return "no throw"})()"#,
            "TypeError",
        ),
        (
            r#"(()=>{var s=new Set();s.add(7);var h=Iterator.prototype.take.call(s,5);var snext=Object.getPrototypeOf(s.values()).next;try{snext.call(h)}catch(e){return e.constructor.name}return "no throw"})()"#,
            "TypeError",
        ),
        // A real collection cursor still works.
        (
            r#"(()=>{var m=new Map();m.set("a",1);var it=m.keys();var r=it.next();return r.value+":"+r.done})()"#,
            "a:false",
        ),
        // The NaN-count close, which the matrix otherwise never observed: the
        // module note above covers a non-callable mapper and a NEGATIVE count,
        // and only those two had a `return`-counting receiver. Node 22 answers
        // '0' here for the same reason it does there — it predates the ES2025
        // ordering.
        (
            r#"(()=>{let c=0;const it={next(){return{value:1,done:false}},return(){c++;return{}},[Symbol.iterator](){return this}};try{Iterator.prototype.take.call(it,NaN)}catch(e){}return String(c)})()"#,
            "1",
        ),
        (
            r#"(()=>{let c=0;const it={next(){return{value:1,done:false}},return(){c++;return{}},[Symbol.iterator](){return this}};try{Iterator.prototype.drop.call(it,NaN)}catch(e){}return String(c)})()"#,
            "1",
        ),
        // A `flatMap` closed while suspended inside an inner iterator must
        // close the OUTER iterator too, even when the inner's `return`
        // misbehaves — ES2025's IfAbruptCloseIterator(backupCompletion,
        // iterated), with the inner's error still the winner. Skipping it
        // leaked the outer iterator, so a generator's `finally` never ran.
        // Adversarial review found this; all three verified against Node 22.
        (
            r#"(()=>{var log=[];var outer={next:function(){return{done:false,value:1}},return:function(){log.push('outer-return');return{}}};outer[Symbol.iterator]=function(){return this};var inner={next:function(){return{done:false,value:2}},return:function(){log.push('inner-return');throw new Error('boom')}};inner[Symbol.iterator]=function(){return this};var h=Iterator.prototype.flatMap.call(outer,function(){return inner});h.next();try{h.return()}catch(e){log.push('caught:'+e.message)}return log.join(',')})()"#,
            "inner-return,outer-return,caught:boom",
        ),
        (
            r#"(()=>{var log=[];var outer={next:function(){return{done:false,value:1}},return:function(){log.push('outer-return');return{}}};outer[Symbol.iterator]=function(){return this};var inner={next:function(){return{done:false,value:2}},return:function(){log.push('inner-return');return 7}};inner[Symbol.iterator]=function(){return this};var h=Iterator.prototype.flatMap.call(outer,function(){return inner});h.next();try{h.return()}catch(e){log.push('caught:'+e.constructor.name)}return log.join(',')})()"#,
            "inner-return,outer-return,caught:TypeError",
        ),
        (
            r#"(()=>{var log=[];var outer={next:function(){return{done:false,value:1}},return:function(){log.push('outer-return');return{}}};outer[Symbol.iterator]=function(){return this};var inner={next:function(){return{done:false,value:2}},return:function(){log.push('inner-return');return{}}};inner[Symbol.iterator]=function(){return this};var h=Iterator.prototype.flatMap.call(outer,function(){return inner});h.next();h.return();return log.join(',')})()"#,
            "inner-return,outer-return",
        ),
    ] {
        assert_eq!(run(probe), expected, "{probe}");
    }
}
