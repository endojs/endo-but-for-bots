//! TEMPORARY audit probe (coverage review, blind spots): broad
//! uninterrupted-vs-resumed twin sweep over state families whose
//! image decoders and restore bodies no audit map read line by line.
#[path = "common/twin.rs"]
mod carry;
#[allow(dead_code)]
mod common;
use carry::twin;
use ironhorse_snapshot::store::MemoryStore;

fn case(name: &str, first: &str, obs: &[&str]) -> String {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut mem = MemoryStore::new();
        twin(first, obs, &mut mem)
    }));
    match r {
        Ok(seen) => format!(
            "OK   {name}: {:?}",
            seen.iter()
                .map(|(c, h, r, _)| if *c { r.clone() } else { format!("!{h}") })
                .collect::<Vec<_>>()
        ),
        Err(e) => {
            let msg = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            format!("FAIL {name}: {}", msg.replace('\n', " | "))
        }
    }
}

#[test]
fn zz_audit_cov_twin_sweep() {
    std::panic::set_hook(Box::new(|_| {}));
    let cases: Vec<(&str, &str, Vec<&str>)> = vec![
        ("temporal-plaindate", "var d = Temporal.PlainDate.from('2024-02-29'); 1",
            vec!["var d; d.add({years: 1}).toString() + ':' + d.dayOfWeek + ':' + d.calendarId"]),
        ("temporal-pdt", "var pdt = Temporal.PlainDateTime.from('2024-01-31T10:20:30.123456789'); 1",
            vec!["var pdt; pdt.add({months: 1}).toString() + ':' + pdt.nanosecond"]),
        ("temporal-zdt", "var z = Temporal.ZonedDateTime.from('2024-01-10T01:30:00+00:00[UTC]'); 1",
            vec!["var z; z.add({hours: 49}).toString() + ':' + z.epochNanoseconds"]),
        ("temporal-duration", "var du = Temporal.Duration.from({hours: 25, minutes: 3, milliseconds: 7}); 1",
            vec!["var du; du.round({largestUnit: 'day', relativeTo: '2024-01-01'}).toString() + ':' + du.negated().toString()"]),
        ("temporal-instant", "var ins = Temporal.Instant.fromEpochMilliseconds(1700000000123); 1",
            vec!["var ins; ins.add({seconds: 1}).toString() + ':' + ins.epochMilliseconds"]),
        ("temporal-misc", "var pt = Temporal.PlainTime.from('12:34:56'); var pym = Temporal.PlainYearMonth.from('2024-02'); var pmd = Temporal.PlainMonthDay.from('--02-29'); 1",
            vec!["var pt, pym, pmd; pt.add({minutes: 30}) + ':' + pym.daysInMonth + ':' + pmd.toPlainDate({year: 2024})"]),
        ("intl-dtf", "var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', dateStyle: 'full', timeStyle: 'long'}); var g = f.format; 1",
            vec!["var f, g; g(0) + '|' + f.formatToParts(86400000).length + '|' + f.resolvedOptions().timeZone"]),
        ("intl-segmenter-midwalk", "var it = new Intl.Segmenter('en', {granularity: 'word'}).segment('hello world foo')[Symbol.iterator](); it.next(); 1",
            vec!["var it; var a = []; for (var s of it) a.push(s.segment + '@' + s.index); a.join(',')"]),
        ("intl-misc", "var lf = new Intl.ListFormat('en', {type: 'disjunction'}); var rtf = new Intl.RelativeTimeFormat('en', {numeric: 'auto'}); var dn = new Intl.DisplayNames('en', {type: 'region'}); var loc = new Intl.Locale('en-Latn-US', {hourCycle: 'h12'}); 1",
            vec!["var lf, rtf, dn, loc; lf.format(['a','b','c']) + '|' + rtf.format(-1, 'day') + '|' + dn.of('FR') + '|' + loc.maximize().toString() + loc.hourCycle"]),
        ("intl-nf-collator", "var nf = new Intl.NumberFormat('de-DE', {style: 'currency', currency: 'EUR'}); var nfmt = nf.format; var co = new Intl.Collator('sv'); var cmp = co.compare; 1",
            vec!["var nfmt, cmp; nfmt(1234.5) + '|' + ['z','a','\\u00e4'].sort(cmp).join('')"]),
        ("map-iter-mutated", "var m = new Map([[1,'a'],[2,'b'],[3,'c']]); var mi = m.entries(); mi.next(); m.delete(2); m.set(4,'d'); 1",
            vec!["var mi; var a = []; for (var e of mi) a.push(e.join('=')); a.join(',')"]),
        ("set-iter-cleared", "var st = new Set([1,2,3]); var si = st.values(); si.next(); st.clear(); st.add(9); 1",
            vec!["var si; [...si].join(',')"]),
        ("string-iter-surrogate", "var sti = 'a\\u{1F600}b'[Symbol.iterator](); sti.next(); 1",
            vec!["var sti; [...sti].map(function (c) { return c.length; }).join(',')"]),
        ("regexp-string-iter", "var ri = 'a1b2c3'.matchAll(/\\d/g); ri.next(); 1",
            vec!["var ri; [...ri].map(function (m) { return m[0] + m.index; }).join(',')"]),
        ("iterator-helpers-midwalk", "var ih = [1,2,3,4,5,6].values().map(function (x) { return x * 2; }).filter(function (x) { return x > 2; }).take(3); ih.next(); var fm = [[1,2],[3,4]].values().flatMap(function (x) { return x; }); fm.next(); fm.next(); var dr = [5,6,7,8].values().drop(2); 1",
            vec!["var ih, fm, dr; [...ih].join(',') + '|' + [...fm].join(',') + '|' + [...dr].join(',')"]),
        ("generator-in-try-finally", "var fin = 0; function* g() { try { yield 1; yield 2; } finally { fin++; } } var gi = g(); gi.next(); 1",
            vec!["var gi, fin; gi.return(9).value + ':' + fin + ':' + gi.next().done"]),
        ("generator-in-catch-throw", "function* gc() { try { yield 1; } catch (e) { yield 'caught:' + e; } } var gci = gc(); gci.next(); 1",
            vec!["var gci; gci.throw('x').value"]),
        ("generator-yield-star", "function* inner() { try { yield 'a'; yield 'b'; } finally { globalThis.innerFin = true; } } function* outer() { yield* inner(); yield 'c'; } var oi = outer(); oi.next(); 1",
            vec!["var oi; [...oi].join(',') + ':' + globalThis.innerFin"]),
        ("async-generator-queue", "async function* ag() { yield 1; await null; yield 2; } var agi = ag(); var agl = []; agi.next().then(function (r) { agl.push(r.value); }); 1",
            vec!["var agi, agl; agi.next().then(function (r) { agl.push(r.value); }); agi.next().then(function (r) { agl.push('done:' + r.done); }); 0", "var agl; agl.join(',')"]),
        ("pending-promise-reactions", "var res; var p = new Promise(function (r) { res = r; }); var out = []; p.then(function (v) { out.push('a' + v); }); p.then(function (v) { out.push('b' + v); }).then(function () { out.push('c'); }); 1",
            vec!["var res; res(5); 0", "var out; out.join(',')"]),
        ("promise-all-progress", "var r1, r2; var pa = Promise.all([new Promise(function (r) { r1 = r; }), new Promise(function (r) { r2 = r; }), 3]); var o2 = []; pa.then(function (v) { o2.push(v.join('+')); }); 1",
            vec!["var r2; r2('y'); 0", "var r1; r1('x'); 0", "var o2; o2.join()"]),
        ("promise-any-allsettled", "var j1, j2; var pany = Promise.any([new Promise(function (_, j) { j1 = j; }), new Promise(function (_, j) { j2 = j; })]); var pas = Promise.allSettled([new Promise(function (_, j) { globalThis.j3 = j; }), 1]); var o4 = []; pany.catch(function (e) { o4.push(e.errors.join('/')); }); pas.then(function (v) { o4.push(v.map(function (x) { return x.status; }).join('/')); }); 1",
            vec!["var j1, j2; j2('B'); j1('A'); globalThis.j3('C'); 0", "var o4; o4.join('|')"]),
        ("async-fn-await-pending", "var rz; var o3 = []; (async function () { try { var v = await new Promise(function (r) { rz = r; }); o3.push('got' + v); } finally { o3.push('fin'); } })(); 1",
            vec!["var rz; rz(1); 0", "var o3; o3.join()"]),
        ("for-await-pending", "var fr; var o5 = []; (async function () { for await (var x of [1, new Promise(function (r) { fr = r; }), 3]) o5.push(x); o5.push('end'); })(); 1",
            vec!["var fr; fr(2); 0", "var o5; o5.join()"]),
        ("array-fromasync-pending", "var rr; var fa = []; Array.fromAsync([new Promise(function (r) { rr = r; }), 2]).then(function (a) { fa.push(a.join()); }); 1",
            vec!["var rr; rr(1); 0", "var fa; fa.join()"]),
        ("weakref-fr", "var tgt = {k: 1}; var wr = new WeakRef(tgt); var frc = []; var frg = new FinalizationRegistry(function (h) { frc.push(h); }); var tok = {}; frg.register(tgt, 'held', tok); 1",
            vec!["var wr, frg, tok; wr.deref().k + ':' + frg.unregister(tok) + ':' + frg.unregister(tok)"]),
        ("proxy-revocable", "var pr = Proxy.revocable({a: 1}, {get: function (t, k) { return 'trap:' + String(k); }}); 1",
            vec!["var pr; pr.proxy.a", "var pr; pr.revoke(); try { pr.proxy.a; 'no' } catch (e) { e.constructor.name }"]),
        ("private-members", "class K { #x = 1; static #s = 2; #m() { return this.#x; } get #g() { return 10; } set #g(v) { this.#x = v; } has(o) { return #x in o; } sum() { return this.#m() + this.#g + K.#s; } bump() { this.#g = 5; } } var k = new K(); 1",
            vec!["var k; k.bump(); k.sum() + ':' + k.has(k) + ':' + k.has({})"]),
        ("disposable-stack", "var ds = new DisposableStack(); var dl = []; ds.defer(function () { dl.push('d1'); }); ds.adopt(5, function (v) { dl.push('a' + v); }); ds.use({[Symbol.dispose]: function () { dl.push('u'); }}); 1",
            vec!["var ds, dl; ds.dispose(); dl.join() + ':' + ds.disposed"]),
        ("async-disposable-stack", "var ads = new AsyncDisposableStack(); var adl = []; ads.defer(async function () { adl.push('x'); }); 1",
            vec!["var ads; ads.disposeAsync(); 0", "var adl, ads; adl.join() + ':' + ads.disposed"]),
        ("bound-function", "function bfn(a, b, c) { return [this.t, a, b, c].join(); } var bf = bfn.bind({t: 'T'}, 1, 2); function Ctor(a) { this.a = a; } var BC = Ctor.bind(null, 'q'); 1",
            vec!["var bf, BC; bf(3) + ':' + bf.name + ':' + bf.length + ':' + new BC().a"]),
        ("buffers", "var ab = new ArrayBuffer(4, {maxByteLength: 16}); var u8 = new Uint8Array(ab); u8[0] = 7; ab.resize(8); var ab2 = new ArrayBuffer(4); var ab3 = ab2.transfer(8); var dv = new DataView(ab, 1); var b64 = new BigInt64Array([-5n]); var f32 = new Float32Array([1.5, NaN]); 1",
            vec!["var ab, u8, ab2, ab3, dv, b64, f32; ab.byteLength + ':' + u8.length + ':' + u8[0] + ':' + ab.maxByteLength + ':' + ab2.detached + ':' + ab3.byteLength + ':' + dv.byteLength + ':' + b64[0] + ':' + f32[1]"]),
        ("symbols", "var sy = Symbol('desc'); var gs = Symbol.for('glob'); var so = {[sy]: 1, [gs]: 2}; 1",
            vec!["var sy, gs, so; so[sy] + so[Symbol.for('glob')] + ':' + Symbol.keyFor(gs) + ':' + sy.description + ':' + Object.getOwnPropertySymbols(so).length"]),
        ("date-regexp", "var dt = new Date(Date.UTC(2020, 1, 29, 12)); var re = /(?<x>a)|b/gy; re.lastIndex = 1; re.test('ba'); 1",
            vec!["var dt, re; dt.toISOString() + ':' + dt.getUTCDay() + ':' + re.lastIndex + ':' + re.flags + ':' + re.exec('baa').groups.x"]),
        ("errors", "var er = new AggregateError([new Error('e1')], 'agg', {cause: 'c'}); var te = new TypeError('tt'); 1",
            vec!["var er, te; er.errors[0].message + er.cause + er.message + (er instanceof AggregateError) + ':' + String(te) + ':' + (typeof er.stack)"]),
        ("arguments-mapped", "function mf(a) { globalThis.setA = function (v) { a = v; }; return arguments; } var ma = mf(1, 2); 1",
            vec!["var ma; setA(9); ma[0] + ':' + ma.length + ':' + Object.prototype.toString.call(ma)"]),
        ("closures-eval-function", "var counter = (function () { var n = 0; return function () { return ++n; }; })(); counter(); var ef = new Function('a', 'return a * 2'); var ec = eval('(function () { var q = 7; return function () { return q; }; })()'); 1",
            vec!["var counter, ef, ec; counter() + ':' + ef(21) + ':' + ec()"]),
        ("objects-integrity", "var fz = Object.freeze({a: 1}); var sl = Object.seal({b: 2}); var ne = Object.preventExtensions({c: 3}); var acc = {get g() { return this._v; }, set g(v) { this._v = v * 2; }}; acc.g = 4; var np = Object.create(null); np.z = 1; 1",
            vec!["var fz, sl, ne, acc, np; Object.isFrozen(fz) + ':' + Object.isSealed(sl) + ':' + Object.isExtensible(ne) + ':' + acc.g + ':' + Object.getPrototypeOf(np)"]),
        ("arrays-sparse", "var sa = [1, , 3]; sa[100] = 5; var la = []; la.length = 4294967295; var wm = new WeakMap(); var wk = {}; wm.set(wk, 'v'); var ws = new WeakSet([wk]); 1",
            vec!["var sa, la, wm, wk, ws; sa.length + ':' + (1 in sa) + ':' + Object.keys(sa).join() + ':' + la.length + ':' + wm.get(wk) + ':' + ws.has(wk)"]),
        ("classes-super-static", "class A { m() { return 'A'; } static s() { return 'sA'; } } class B extends A { m() { return super.m() + 'B'; } static s() { return super.s() + 'B'; } static { this.init = 'blk'; } } var bi = new B(); 1",
            vec!["var bi, B; bi.m() + ':' + B.s() + ':' + B.init"]),
        ("tagged-template-identity", "function tag(s) { return s; } function tt() { return tag`a${1}b`; } var first = tt(); 1",
            vec!["var first, tt; (first === tt()) + ':' + Object.isFrozen(first) + ':' + first.raw.join('|')"]),
        ("json-raw-groupby", "var rj = JSON.rawJSON('12345678901234567890'); var gb = Object.groupBy([1, 2, 3], function (x) { return x % 2 ? 'odd' : 'even'; }); var mg = Map.groupBy([1, 2, 3], function (x) { return x % 2; }); 1",
            vec!["var rj, gb, mg; JSON.stringify({v: rj}) + ':' + gb.odd.join() + ':' + mg.get(0).join() + ':' + Object.getPrototypeOf(gb)"]),
        ("generator-states", "function* g2() { yield 1; } var notStarted = g2(); var done = g2(); done.next(); done.next(); 1",
            vec!["var notStarted, done; notStarted.next().value + ':' + done.next().done"]),
        ("string-number-wrappers", "var sw = new String('ab'); sw.extra = 1; var nw = new Number(5); var bw = new Boolean(false); 1",
            vec!["var sw, nw, bw; sw.length + sw[1] + sw.extra + ':' + (nw + 1) + ':' + (bw ? 'T' : 'F') + typeof bw"]),
    ];
    let mut lines = Vec::new();
    for (name, first, obs) in &cases {
        lines.push(case(name, first, obs));
    }
    let _ = std::panic::take_hook();
    for l in &lines {
        println!("{l}");
    }
}
