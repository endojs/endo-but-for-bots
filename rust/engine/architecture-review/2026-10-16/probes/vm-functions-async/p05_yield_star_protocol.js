const log = [];
// 1. missing throw: close iterator, then TypeError
const noThrow = { [Symbol.iterator]() { return this; }, next() { return { value: 1, done: false }; }, return() { log.push('closed'); return {}; } };
function* d1() { yield* noThrow; }
const g1 = d1(); g1.next();
try { g1.throw(new Error('x')); } catch (e) { log.push(e.constructor.name); }
// 2. return forwarding with value; delegate return result done:false keeps going
let calls = 0;
const ret = { [Symbol.iterator]() { return this; }, next() { return { value: 'n', done: false }; }, return(v) { calls++; return calls === 1 ? { value: 'r1', done: false } : { value: v + '!', done: true }; } };
function* d2() { try { yield* ret; } finally { log.push('d2-finally'); } }
const g2 = d2(); g2.next();
const a = g2.return('V'); log.push(JSON.stringify(a));
const b = g2.return('W'); log.push(JSON.stringify(b));
// 3. throw forwarding to a delegate whose throw returns a result
const thr = { [Symbol.iterator]() { return this; }, next() { return { value: 'n', done: false }; }, throw(e) { return { value: 'caught ' + e, done: false }; } };
function* d3() { const r = yield* thr; }
const g3 = d3(); g3.next(); log.push(JSON.stringify(g3.throw('E')));
// 4. return() on generator suspended in try/finally that yields in finally
function* d4() { try { yield 1; } finally { yield 'f'; log.push('after-f'); } }
const g4 = d4(); g4.next(); log.push(JSON.stringify(g4.return(9))); log.push(JSON.stringify(g4.next())); 
// 5. generator re-entrancy
function* d5() { try { g5.next(); } catch (e) { yield e.constructor.name; } }
const g5 = d5(); log.push(g5.next().value);
// 6. return value override in finally
function* d6() { try { yield 1; } finally { return 'override'; } }
const g6 = d6(); g6.next(); log.push(JSON.stringify(g6.return('orig')));
throw new Error(JSON.stringify(log));
