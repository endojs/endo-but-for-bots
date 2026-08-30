#![forbid(unsafe_code)]
//! ironhorse-fuzz: the differential and decoder fuzz logic (design
//! § Fuzzability). The two stage-1 cargo-fuzz targets are thin
//! libFuzzer wrappers (`fuzz/fuzz_targets/`) over the functions here;
//! keeping the substance in a plain, `forbid(unsafe_code)` lib means it
//! builds and is unit-tested without a libFuzzer toolchain, and the
//! same generator/comparator seeds the differential corpus.
//!
//! - **Target 1, differential source fuzzing** (the flagship): a
//!   structure-aware generator produces a subset-grammar program from
//!   raw fuzzer bytes; `differential_check` feeds identical source to
//!   ironhorse and the XS oracle and compares completion kind, result
//!   string, and computron count. Any divergence is a finding.
//! - **Target 2, bytecode decoder fuzzing**: `decoder_is_panic_free`
//!   drives arbitrary/truncated bytes through the decoder and
//!   interpreter, which must degrade to a `Halt::Decode`, never panic
//!   (XS treats bytecode as trusted; ironhorse's loader must not).
//!
//! **When an arm finds a trophy** (a minimized, fixed divergence), it lands a
//! durable regression, not a change to a generator: a source-level divergence
//! becomes a test262 case under `ironhorse-262/cases/regressions/` (arm named in
//! `info:`); a bytecode/decoder trophy keeps its lock as a Rust regression test
//! here (e.g. `decoder_hang_is_bounded_not_infinite`). See the fix workflow in
//! `rust/engine/README.md` and `ironhorse-262/cases/regressions/README.md`.

use ironhorse_vm::{disassemble, run_program, run_program_bounded};

/// Stage-3b XSRE matcher fuzz arm (child 8/9): a structure-aware regexp
/// generator + differential check of `ironhorse-regexp` against the pin.
pub mod regexp;
pub use regexp::{differential_check_regexp, gen_regexp, RegExpCase};

/// Stage-6 child 4: the snapshot round-trip-invariance and malformed-atom
/// decoder fuzz arms over `ironhorse-snapshot`'s `XS_M` writer/reader.
pub mod snapshot;
pub use snapshot::{
    decoder_is_error_free, gen_machine_image, roundtrip_generated_is_invariant,
    roundtrip_image_is_invariant, roundtrip_program_is_invariant, suspend_resume_is_transparent,
    RoundtripDivergence,
};

/// A cursor over fuzzer-provided bytes, used to drive the grammar
/// deterministically (a minimal `arbitrary::Unstructured`).
struct Bytes<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Bytes<'a> {
    fn new(data: &'a [u8]) -> Self {
        Bytes { data, pos: 0 }
    }
    fn next(&mut self) -> u8 {
        if self.data.is_empty() {
            return 0;
        }
        let b = self.data[self.pos % self.data.len()];
        self.pos = self.pos.wrapping_add(1);
        b
    }
    fn choice(&mut self, n: u8) -> u8 {
        self.next() % n
    }
}

/// Structure-aware generator: fold raw bytes into a program in the
/// stage-1 subset grammar (integer/number/boolean literals combined
/// with the implemented arithmetic, bitwise, comparison, logic, unary,
/// and conditional operators). `depth` bounds recursion so generation
/// terminates.
pub fn gen_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    gen_expr(&mut b, 4)
}

fn gen_expr(b: &mut Bytes, depth: u8) -> String {
    if depth == 0 {
        return gen_atom(b);
    }
    match b.choice(9) {
        0 => {
            let op = ["+", "-", "*", "/", "%"][b.choice(5) as usize];
            format!("({} {} {})", gen_expr(b, depth - 1), op, gen_expr(b, depth - 1))
        }
        1 => {
            let op = ["&", "|", "^", "<<", ">>", ">>>"][b.choice(6) as usize];
            format!("({} {} {})", gen_expr(b, depth - 1), op, gen_expr(b, depth - 1))
        }
        2 => {
            let op = ["<", "<=", ">", ">=", "===", "!==", "==", "!="][b.choice(8) as usize];
            format!("({} {} {})", gen_expr(b, depth - 1), op, gen_expr(b, depth - 1))
        }
        3 => {
            let op = ["&&", "||"][b.choice(2) as usize];
            format!("({} {} {})", gen_expr(b, depth - 1), op, gen_expr(b, depth - 1))
        }
        4 => format!("(-{})", gen_expr(b, depth - 1)),
        5 => format!("(!{})", gen_expr(b, depth - 1)),
        6 => format!("(~{})", gen_expr(b, depth - 1)),
        7 => format!(
            "({} ? {} : {})",
            gen_expr(b, depth - 1),
            gen_expr(b, depth - 1),
            gen_expr(b, depth - 1)
        ),
        _ => gen_atom(b),
    }
}

/// Structure-aware generator for the **stage-2 surface**: a program
/// with `var` bindings and a backward-branch loop that mutates them,
/// returning one of the bindings. Every generated program is valid and
/// terminating (the loop bound is a small literal and the counter only
/// increments), exercising the frame/scope/variable/loop opcodes the
/// differential harness compares on results. Computrons are not yet
/// bit-exact for this surface (run-time allocation metering awaits the
/// faithful heap), so [`differential_check_result_only`] drives it.
pub fn gen_statement_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    let seed0 = (b.next() % 20) as i32 - 5;
    let seed1 = (b.next() % 20) as i32 - 5;
    let bound = 1 + (b.next() % 6) as i32; // 1..=6 iterations
    let body_op = ["+", "-", "*"][b.choice(3) as usize];
    let step = 1 + (b.next() % 3) as i32; // keep the counter moving
    let ret_both = b.choice(2) == 0;
    // v0 accumulates over the loop; v1 is a second live binding.
    let mut s = String::new();
    s.push_str(&format!("var v0 = {}; var v1 = {}; ", seed0, seed1));
    s.push_str(&format!(
        "for (var i = 0; i < {}; i = i + {}) {{ v0 = v0 {} i }} ",
        bound, step, body_op
    ));
    if ret_both {
        s.push_str("v0 + v1");
    } else {
        s.push_str("v0");
    }
    s
}

/// Structure-aware generator for the **stage-2b surface**: valid,
/// terminating programs that exercise the object model, user-function
/// calls, closures, and thrown-and-caught exceptions — the machinery this
/// stage made **bit-exact** (result AND computron), so the generated
/// programs are driven by the full [`differential_check`], not the
/// result-only variant. Every branch stays inside the small-integer domain
/// (values bounded, only `+`/`-`/`*`, no division) so results and their
/// `String()` renderings are unambiguous and the loop/closure/recursion
/// counts are bounded.
pub fn gen_stage2b_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    match b.choice(4) {
        0 => gen_object_program(&mut b),
        1 => gen_call_program(&mut b),
        2 => gen_closure_program(&mut b),
        _ => gen_exception_program(&mut b),
    }
}

/// A small non-negative integer literal (0..=9), keeping generated values
/// bounded so repeated `+`/`-`/`*` never overflows the integer fast path
/// or produces a magnitude whose `String()` differs between the engines
/// (they agree regardless, but small values keep the corpus legible).
fn small_int(b: &mut Bytes) -> i32 {
    (b.next() % 10) as i32
}

/// One of the overflow-safe, throw-free binary operators.
fn small_op(b: &mut Bytes) -> &'static str {
    ["+", "-", "*"][b.choice(3) as usize]
}

/// Object model: an object literal or a `{}`-plus-dynamic-property build,
/// then two own-property reads combined. Exercises `OBJECT`,
/// `NEW_PROPERTY`/`SET_PROPERTY`, and `GET_PROPERTY`.
fn gen_object_program(b: &mut Bytes) -> String {
    let x = small_int(b);
    let y = small_int(b);
    let op = small_op(b);
    if b.choice(2) == 0 {
        format!("var o = {{a: {}, b: {}}}; o.a {} o.b", x, y, op)
    } else {
        format!("var o = {{}}; o.x = {}; o.y = {}; o.x {} o.y", x, y, op)
    }
}

/// User functions: an IIFE or a function stored in a var, called with one
/// or two arguments. Exercises `constructor_function`/`function`/`code`/
/// `call`/`run`/`argument`/`end` frame switching.
fn gen_call_program(b: &mut Bytes) -> String {
    let x = small_int(b);
    let y = small_int(b);
    let op = small_op(b);
    match b.choice(3) {
        0 => format!("(function(p){{return p {} {}}})({})", op, y, x),
        1 => format!("(function(p,q){{return p {} q}})({}, {})", op, x, y),
        _ => format!("var f = function(p){{return p {} {}}}; f({})", op, y, x),
    }
}

/// Closures: a counter factory whose returned inner function mutates a
/// captured cell across a bounded number of calls, or a curried two-stage
/// adder. Exercises `new_closure`/`store`/`retrieve`/`get_closure`/
/// `pull_closure` and the shared-cell model.
fn gen_closure_program(b: &mut Bytes) -> String {
    let seed = small_int(b);
    let step = small_int(b);
    if b.choice(2) == 0 {
        let calls = 1 + (b.next() % 3) as usize; // 1..=3 calls
        let mut s = format!(
            "var mk = function(){{var c = {}; return function(){{c = c + {}; return c}}}}; var f = mk();",
            seed, step
        );
        for i in 0..calls {
            s.push_str(if i + 1 < calls { " f();" } else { " f()" });
        }
        s
    } else {
        let x = small_int(b);
        let y = small_int(b);
        format!("var add = function(a){{return function(c){{return a + c}}}}; add({})({})", x, y)
    }
}

/// Thrown-and-caught exceptions: a caught throw whose value is used, a try
/// with no throw, or a try/catch/finally that observes both paths.
/// Exercises `catch`/`throw`/`exception`/`uncatch` and the finally
/// status-temporary skeleton — all caught (so `BothComplete`, bit-exact).
fn gen_exception_program(b: &mut Bytes) -> String {
    let n = small_int(b);
    let m = small_int(b);
    let op = small_op(b);
    match b.choice(3) {
        0 => format!("try {{ throw {} }} catch(e) {{ e {} {} }}", n, op, m),
        1 => format!("try {{ {} {} {} }} catch(e) {{ {} }}", n, op, m, m),
        _ => format!(
            "var r = 0; try {{ throw {} }} catch(e) {{ r = e }} finally {{ r = r + {} }} r",
            n, m
        ),
    }
}

/// Structure-aware generator for the **stage-3 arrays surface**: the array
/// exotic object's grammar that is **bit-exact** (result AND computron) —
/// array literals (with holes), computed index get/set over the item chunk,
/// and the `length` accessor get/set. Deliberately excludes the honest-skip
/// cases (integer-indexed *ordinary* objects, runtime-minted string keys,
/// the iteration protocol, and `Array.prototype` methods), so every program
/// it emits rides the full [`differential_check`]. Values stay in the small
/// non-negative integer domain so element `String()` renderings are
/// unambiguous, and indices stay small so the item chunk grows a bounded
/// amount.
pub fn gen_stage3_arrays_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    // A small array literal (1..=4 elements) of small ints, optionally with
    // one hole, rendered as its source text.
    let n = 1 + (b.next() % 4) as usize; // 1..=4 elements
    let hole_at = if b.choice(2) == 0 { Some((b.next() % n as u8) as usize) } else { None };
    let mut elems: Vec<String> = Vec::with_capacity(n);
    for i in 0..n {
        if Some(i) == hole_at {
            elems.push(String::new()); // an elision → a hole
        } else {
            elems.push(small_int(&mut b).to_string());
        }
    }
    let lit = format!("[{}]", elems.join(","));
    match b.choice(6) {
        // The literal itself (Array.prototype.toString → join(",")).
        0 => lit,
        // An indexed read (in range or one past the end → undefined).
        1 => {
            let i = (b.next() as usize) % (n + 1);
            format!("var a={}; a[{}]", lit, i)
        }
        // An indexed overwrite, then read it back.
        2 => {
            let i = (b.next() as usize) % n;
            let v = small_int(&mut b);
            format!("var a={}; a[{}]={}; a[{}]", lit, i, v, i)
        }
        // A grow-past-the-end write, then observe the new length.
        3 => {
            let k = n + 1 + (b.next() % 3) as usize;
            let v = small_int(&mut b);
            format!("var a={}; a[{}]={}; a.length", lit, k, v)
        }
        // A `length` read.
        4 => format!("var a={}; a.length", lit),
        // A `length` store (grow with holes, or shrink dropping items), then
        // the resulting array joined.
        _ => {
            let m = (b.next() % (n as u8 + 3)) as usize;
            format!("var a={}; a.length={}; a", lit, m)
        }
    }
}

/// Structure-aware generator for the **dense `Array.prototype` mutation
/// methods** (`push`/`pop`/`indexOf`) — the fast paths that are bit-exact
/// (result AND computron). It always builds a **dense** literal (no holes, so
/// `fxCheckArray`'s fast path applies), then applies a method and observes its
/// return value, the resulting array, or the length. Excludes `join` (its
/// per-element `ToString` metering is a later increment) and sparse receivers
/// (which take XS's slow path). Rides the full symbol-linking differential
/// check.
pub fn gen_stage3_array_methods_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    let n = (b.next() % 5) as usize; // 0..=4 dense elements
    let elems: Vec<String> = (0..n).map(|_| small_int(&mut b).to_string()).collect();
    let lit = format!("[{}]", elems.join(","));
    // `with` requires a non-empty array (out-of-range is a RangeError), so
    // restrict its shape to n>=1 by folding into copyWithin when empty.
    match b.choice(22) {
        // push one, observe the new length (its return value).
        0 => format!("var a={}; a.push({})", lit, small_int(&mut b)),
        // push one, observe the resulting array.
        1 => format!("var a={}; a.push({}); a", lit, small_int(&mut b)),
        // push several, observe the length.
        2 => format!(
            "var a={}; a.push({},{}); a.length",
            lit,
            small_int(&mut b),
            small_int(&mut b)
        ),
        // pop, observe the removed element.
        3 => format!("var a={}; a.pop()", lit),
        // pop, observe the resulting array and length.
        4 => format!("var a={}; a.pop(); a.length", lit),
        // indexOf a value that may or may not be present.
        5 => format!("var a={}; a.indexOf({})", lit, small_int(&mut b)),
        // includes a value that may or may not be present.
        6 => format!("var a={}; a.includes({})", lit, small_int(&mut b)),
        // lastIndexOf a value that may or may not be present.
        7 => format!("var a={}; a.lastIndexOf({})", lit, small_int(&mut b)),
        // fill a (possibly bounded) range, observe the result.
        8 => {
            let v = small_int(&mut b);
            if b.choice(2) == 0 {
                format!("var a={}; a.fill({}); a", lit, v)
            } else {
                let s = (b.next() as usize) % (n + 1);
                format!("var a={}; a.fill({},{}); a", lit, v, s)
            }
        }
        // slice a range into a new array.
        9 => {
            let s = (b.next() as usize) % (n + 1);
            if b.choice(2) == 0 {
                format!("var a={}; a.slice({}); a", lit, s)
            } else {
                let e = s + (b.next() as usize) % (n + 1 - s.min(n));
                format!("var a={}; a.slice({},{}); a", lit, s, e)
            }
        }
        // join with the default separator (raw-exact; a non-default string
        // separator carries only a sub-computron residual).
        10 => format!("var a={}; a.join()", lit),
        // at a (possibly negative, possibly out-of-range) index.
        11 => {
            let i = (b.next() as i32 % (2 * (n as i32 + 2))) - (n as i32 + 2);
            format!("var a={}; a.at({})", lit, i)
        }
        // reverse in place, observe the result.
        12 => format!("var a={}; a.reverse(); a", lit),
        // shift the first element off, observe the removed value.
        13 => format!("var a={}; a.shift(); a", lit),
        // unshift one or two elements, observe the result.
        14 => {
            if b.choice(2) == 0 {
                format!("var a={}; a.unshift({}); a", lit, small_int(&mut b))
            } else {
                format!(
                    "var a={}; a.unshift({},{}); a",
                    lit,
                    small_int(&mut b),
                    small_int(&mut b)
                )
            }
        }
        // concat an array and/or a value, observe the result.
        15 => match b.choice(3) {
            0 => format!(
                "var a={}; a.concat([{},{}]); a",
                lit,
                small_int(&mut b),
                small_int(&mut b)
            ),
            1 => format!("var a={}; a.concat({}); a", lit, small_int(&mut b)),
            _ => format!(
                "var a={}; a.concat([{}],{}); a",
                lit,
                small_int(&mut b),
                small_int(&mut b)
            ),
        },
        // copyWithin a block in place, observe the result.
        16 => {
            let t = (b.next() as usize) % (n + 1);
            let s = (b.next() as usize) % (n + 1);
            format!("var a={}; a.copyWithin({},{}); a", lit, t, s)
        }
        // with: replace an in-range index into a new array (n>=1; else fall
        // back to a copyWithin so the index is always valid).
        17 => {
            if n == 0 {
                format!("var a={}; a.copyWithin(0,0); a", lit)
            } else {
                let i = (b.next() as usize) % n;
                format!("var a={}; a.with({},{}); a", lit, i, small_int(&mut b))
            }
        }
        // toReversed into a new array, joined.
        18 => format!("{}.toReversed().join()", lit),
        // splice: delete and/or insert a bounded range, observe the result.
        19 => {
            let s = (b.next() as usize) % (n + 1);
            let d = (b.next() as usize) % (n + 1 - s.min(n));
            match b.choice(3) {
                0 => format!("var a={}; a.splice({},{}); a.join()", lit, s, d),
                1 => format!(
                    "var a={}; a.splice({},{},{}); a.join()",
                    lit,
                    s,
                    d,
                    small_int(&mut b)
                ),
                _ => format!("var a={}; a.splice({},{})", lit, s, d),
            }
        }
        // flat a one-level-nested array of the elements.
        20 => {
            // Wrap some elements in singleton sub-arrays so flat has work.
            let wrapped: Vec<String> = elems
                .iter()
                .enumerate()
                .map(|(i, e)| if i % 2 == 0 { format!("[{}]", e) } else { e.clone() })
                .collect();
            format!("[{}].flat().join()", wrapped.join(","))
        }
        // toSpliced: a non-mutating splice into a new array, joined. The
        // receiver is untouched (verified: the source `a` is unchanged).
        _ => {
            let s = (b.next() as usize) % (n + 1);
            let d = (b.next() as usize) % (n + 1 - s.min(n));
            match b.choice(3) {
                0 => format!("var a={}; a.toSpliced({},{}).join()", lit, s, d),
                1 => format!(
                    "var a={}; a.toSpliced({},{},{}).join()",
                    lit,
                    s,
                    d,
                    small_int(&mut b)
                ),
                _ => format!("var a={}; a.toSpliced({}); a.join()", lit, s),
            }
        }
    }
}

/// Structure-aware generator for the **array iterator objects**
/// (`values`/`keys`/`entries` + `next` over the reused result object) — the
/// bit-exact (result AND computron) explicit-iterator grammar. Builds a dense
/// literal, opens an iterator of one of the three kinds, advances it a bounded
/// number of `next()` calls (possibly past the end to reach `done`), and reads
/// `.value` or `.done` off the final result. Rides the full symbol-linking
/// differential check.
pub fn gen_stage3_array_iterators_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    let n = (b.next() % 5) as usize; // 0..=4 dense elements
    let elems: Vec<String> = (0..n).map(|_| small_int(&mut b).to_string()).collect();
    let lit = format!("[{}]", elems.join(","));
    let method = ["values", "keys", "entries"][b.choice(3) as usize];
    // 1..=(n+2) next() calls, so some runs step past the end into `done`.
    let advances = 1 + (b.next() as usize % (n + 2));
    let field = if b.choice(2) == 0 { "value" } else { "done" };
    let mut s = format!("var it={}.{}();", lit, method);
    for i in 0..advances {
        if i + 1 < advances {
            s.push_str(" it.next();");
        } else {
            s.push_str(&format!(" it.next().{}", field));
        }
    }
    s
}

/// Structure-aware generator for **`for-of` over an array literal** — the
/// bit-exact (result AND computron) iteration grammar. Builds a dense literal
/// and a bounded reduce/count loop over it. The loop body stays inside the
/// overflow-safe small-integer domain (`+`/`-`/`*`), so results are
/// unambiguous. Rides the full symbol-linking differential check.
pub fn gen_stage3_for_of_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    let n = (b.next() % 5) as usize; // 0..=4 dense elements
    let elems: Vec<String> = (0..n).map(|_| small_int(&mut b).to_string()).collect();
    let lit = format!("[{}]", elems.join(","));
    match b.choice(3) {
        // A reduce with +/-/*.
        0 => {
            let op = small_op(&mut b);
            let seed = small_int(&mut b);
            format!("var s={}; for (var x of {}) s=s{}x; s", seed, lit, op)
        }
        // A count.
        1 => format!("var n=0; for (var x of {}) n=n+1; n", lit),
        // String concatenation of the elements.
        _ => format!("var s=\"\"; for (var x of {}) s=s+x; s", lit),
    }
}

/// Structure-aware generator for **`for-of` over a string** — the string
/// iterator yields each code point as a one-character string. Builds a bounded
/// ASCII string (BMP, single-byte code points — astral/surrogate content self-
/// names an honest skip, so it is excluded here) and a concatenation/count
/// loop over it. Rides the full symbol-linking differential check.
pub fn gen_stage3_string_for_of_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    let n = (b.next() % 6) as usize; // 0..=5 characters
    // Draw from a fixed ASCII alphabet so every char is a single UTF-8 byte.
    const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    let s: String = (0..n).map(|_| ALPHA[(b.next() as usize) % ALPHA.len()] as char).collect();
    match b.choice(3) {
        // Forward concatenation (reconstructs the string).
        0 => format!("var r=\"\"; for (var c of \"{}\") r=r+c; r", s),
        // Reverse concatenation.
        1 => format!("var r=\"\"; for (var c of \"{}\") r=c+r; r", s),
        // A count of the code points.
        _ => format!("var n=0; for (var c of \"{}\") n=n+1; n", s),
    }
}

/// Structure-aware generator for the **stage-3 text-math-json** surface: the
/// `Math` statics, `String.prototype` methods over the CESU-8 chunk, the
/// `Number` predicates, `parseInt`/`parseFloat`/`isNaN`, and `JSON.stringify`
/// of a primitive — every emitted program bit-exact (result AND computron)
/// against the pin. Only the raw-clean subset is drawn (numeric `Math` args,
/// ASCII strings so case/`.length`/index math stays byte==unit, string search/
/// parse arguments, non-negative small `repeat` counts, decimal `toString`),
/// so the arm rides the full symbol-linking differential check. Rides
/// [`differential_check_with_symbols`] (the built-ins relink by name).
pub fn gen_stage3_text_math_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    // A short ASCII string literal (single-UTF-8-byte code units).
    const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    let mk_str = |b: &mut Bytes| -> String {
        let n = (b.next() % 5) as usize; // 0..=4 characters
        (0..n).map(|_| ALPHA[(b.next() as usize) % ALPHA.len()] as char).collect()
    };
    match b.choice(5) {
        // Math statics — algebraically-exact / correctly-rounded functions
        // over small numeric literals (canonical NaN never leaks here).
        0 => {
            let x = (b.next() % 40) as i32 - 20; // -20..=19
            match b.choice(8) {
                0 => format!("Math.abs({})", x),
                1 => format!("Math.sign({})", x),
                2 => format!("Math.floor({}.5)", x),
                3 => format!("Math.ceil({}.5)", x),
                4 => format!("Math.round({}.5)", x),
                5 => format!("Math.trunc({}.5)", x),
                6 => format!("Math.sqrt({})", x.abs()),
                _ => format!("Math.max({}, {})", x, (b.next() % 40) as i32 - 20),
            }
        }
        // String.prototype methods over an ASCII literal.
        1 => {
            let s = mk_str(&mut b);
            let len = s.chars().count() as i32;
            let i = if len > 0 { (b.next() as i32) % len } else { 0 };
            match b.choice(9) {
                0 => format!("\"{}\".length", s),
                1 => format!("\"{}\".toUpperCase()", s),
                2 => format!("\"{}\".toLowerCase()", s),
                3 => format!("\"{}\".charCodeAt({})", s, i),
                4 => format!("\"{}\".charAt({})", s, i),
                5 => format!("\"{}\".slice({})", s, i),
                6 => format!("\"{}\".concat(\"{}\")", s, mk_str(&mut b)),
                7 => format!("\"{}\".repeat({})", s, b.next() % 4),
                _ => format!("\"{}\".includes(\"{}\")", s, mk_str(&mut b)),
            }
        }
        // Number predicates / parseInt / parseFloat / isNaN.
        2 => {
            let x = (b.next() % 40) as i32 - 20;
            match b.choice(6) {
                0 => format!("Number.isInteger({})", x),
                1 => format!("Number.isFinite({})", x),
                2 => format!("Number.isNaN({})", x),
                3 => format!("parseInt(\"{}\")", x),
                4 => format!("parseFloat(\"{}.5\")", x),
                _ => format!("isNaN({})", x),
            }
        }
        // JSON.stringify of a primitive.
        3 => {
            let s = mk_str(&mut b);
            match b.choice(3) {
                0 => format!("JSON.stringify({})", (b.next() % 40) as i32 - 20),
                1 => format!("JSON.stringify(\"{}\")", s),
                _ => "JSON.stringify(true)".to_string(),
            }
        }
        // A small chain: a String method feeding a Number predicate / concat.
        _ => {
            let s = mk_str(&mut b);
            match b.choice(3) {
                0 => format!("Number.isInteger(parseInt(\"{}7\"))", s.len()),
                1 => format!("var t=\"{}\"; t.concat(t)", s),
                _ => format!("Math.max(Math.abs(-{}), {})", b.next() % 10, b.next() % 10),
            }
        }
    }
}

/// Structure-aware generator for the **stage-3b json-metering** surface:
/// `JSON.stringify` over a structured (object/array) value built recursively
/// from primitives, objects, and arrays — every emitted program bit-exact
/// (serialized value AND computron) against the pin. Draws only the raw-clean
/// subset: numeric/boolean/null/ASCII-string leaves, string keys, and bounded
/// depth/breadth, avoiding the self-named corners (callable values,
/// `toJSON`/wrapper objects, a replacer/space argument). Depth and breadth are
/// kept small on purpose: a *large* nested object literal accrues a
/// sub-computron raw drift in ironhorse's object-literal *construction* metering
/// (visible on the bare `var v = {…}` literal, independent of JSON) that can
/// tip a computron boundary — a pre-existing object-literal issue outside the
/// JSON surface. The bound keeps this arm a clean differential test of the JSON
/// *stringify* metering itself. Rides [`differential_check_with_symbols`] (the
/// `JSON` namespace relinks by name).
pub fn gen_json_structured_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    fn mk_key(b: &mut Bytes) -> String {
        let n = 1 + (b.next() % 4) as usize; // 1..=4 characters, non-empty key
        (0..n).map(|_| ALPHA[(b.next() as usize) % ALPHA.len()] as char).collect()
    }
    fn mk_leaf(b: &mut Bytes) -> String {
        match b.choice(5) {
            0 => ((b.next() % 40) as i32 - 20).to_string(),
            1 => "true".to_string(),
            2 => "false".to_string(),
            3 => "null".to_string(),
            _ => {
                let n = (b.next() % 4) as usize;
                let s: String =
                    (0..n).map(|_| ALPHA[(b.next() as usize) % ALPHA.len()] as char).collect();
                format!("\"{}\"", s)
            }
        }
    }
    // A value at the given remaining depth: a leaf at depth 0, else a leaf,
    // object, or array (bounded breadth).
    fn mk_value(b: &mut Bytes, depth: u8) -> String {
        if depth == 0 || b.next() % 3 == 0 {
            return mk_leaf(b);
        }
        if b.next() % 2 == 0 {
            let n = (b.next() % 3) as usize; // 0..=2 keys (small literal)
            let mut parts = Vec::new();
            for i in 0..n {
                // Distinct keys per object so the small literal stays
                // construction-exact (a duplicate key is valid but needless).
                parts.push(format!("{}{}:{}", mk_key(b), i, mk_value(b, depth - 1)));
            }
            format!("{{{}}}", parts.join(","))
        } else {
            let n = (b.next() % 3) as usize; // 0..=2 elements (small literal)
            let parts: Vec<String> = (0..n).map(|_| mk_value(b, depth - 1)).collect();
            format!("[{}]", parts.join(","))
        }
    }
    format!("JSON.stringify({})", mk_value(&mut b, 2))
}

/// Structure-aware generator for the **stage-3b json-metering** parse surface:
/// `JSON.parse(text)` over well-formed JSON text built recursively from
/// primitives, arrays, and objects — every emitted program bit-exact (result
/// AND computron) against the pin. The JSON is emitted as a JS double-quoted
/// string literal (the parser reads its bytes); depth/breadth can go deeper than
/// the stringify arm because the argument is a single string literal, not a
/// nested object literal (so the object-literal construction drift is absent).
/// Draws only the raw-clean subset: integer/boolean/null/ASCII-string leaves,
/// distinct ASCII keys, no astral escapes — avoiding the self-named corners
/// (reviver, astral, malformed). Rides [`differential_check_with_symbols`].
pub fn gen_json_parse_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    fn mk_word(b: &mut Bytes) -> String {
        let n = 1 + (b.next() % 5) as usize;
        (0..n).map(|_| ALPHA[(b.next() as usize) % ALPHA.len()] as char).collect()
    }
    // A JSON value string at the given remaining depth.
    fn mk_json(b: &mut Bytes, depth: u8) -> String {
        if depth == 0 || b.next() % 3 == 0 {
            return match b.choice(5) {
                0 => ((b.next() % 200) as i32 - 100).to_string(),
                1 => "true".to_string(),
                2 => "false".to_string(),
                3 => "null".to_string(),
                _ => format!("\"{}\"", mk_word(b)),
            };
        }
        if b.next() % 2 == 0 {
            let n = (b.next() % 4) as usize; // 0..=3 members, keys distinct by index
            let parts: Vec<String> = (0..n)
                .map(|i| format!("\"{}{}\":{}", mk_word(b), i, mk_json(b, depth - 1)))
                .collect();
            format!("{{{}}}", parts.join(","))
        } else {
            let n = (b.next() % 4) as usize; // 0..=3 elements
            let parts: Vec<String> = (0..n).map(|_| mk_json(b, depth - 1)).collect();
            format!("[{}]", parts.join(","))
        }
    }
    // Escape the JSON text as a JS double-quoted string literal.
    let json = mk_json(&mut b, 3);
    let mut lit = String::from("\"");
    for c in json.chars() {
        match c {
            '"' => lit.push_str("\\\""),
            '\\' => lit.push_str("\\\\"),
            _ => lit.push(c),
        }
    }
    lit.push('"');
    format!("JSON.parse({})", lit)
}

/// Structure-aware generator for the **stage-3b promises** surface: a
/// fulfilled resolution chain over `Promise`, its `resolve` static, and
/// `then`/`catch`, driven to the pump-loop drain — bit-exact (result AND
/// computron) against the pin. A source promise (`Promise.resolve(n)`, a
/// `new Promise` whose executor synchronously resolves, or a never-settling
/// pending promise) is followed by a bounded chain of reactions; each handler
/// is either an assignment to the observed variable `x`, an integer return
/// (chaining a primitive to the next reaction), or absent (a pass-through
/// `then()`/`catch()`). The completion observes `x`.
///
/// The generator stays inside the **fulfilled-chain** regime on purpose: a
/// handler never throws and never returns a reference (both are honest named
/// skips — a throwing/reference-returning handler), and no rejection is
/// emitted, so the `fxAddUnhandledRejection` metered list walk (the one
/// `mxMeter` site in `xsPromise.c`, whose per-entry cost grows with the
/// unhandled-list length) never fires more than the single-entry case the
/// constants absorb. Rejection routing (`then(undefined, h)` / `catch`) is
/// covered bit-exact by the curated corpus, which bounds it to a single
/// rejection. Rides the full symbol-linking differential check.
pub fn gen_stage3b_promise_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    let val = (b.next() % 20) as i32; // the resolution value
    // The source promise — always fulfilled or pending (never rejected).
    let source = match b.choice(4) {
        0 => format!("Promise.resolve({})", val),
        1 => format!("new Promise(function(res){{res({})}})", val),
        2 => format!("new Promise(function(resolve,reject){{resolve({})}})", val),
        // A never-settling pending promise: its reactions register but never
        // fire, so the completion stays at the initial `x`.
        _ => "new Promise(function(){})".to_string(),
    };
    // A bounded chain of reactions. `then(h)` and `then()` (pass-through) keep
    // the promise fulfilled; `catch(h)` on a fulfilled promise passes through
    // (its handler never runs), a valid covered shape.
    let steps = (b.next() % 4) as usize; // 0..=3 chained reactions
    let mut chain = String::new();
    for _ in 0..steps {
        let step = match b.choice(4) {
            // Assignment handler: returns undefined → resolves the derived with
            // undefined (a covered pass-through of `undefined` downstream).
            0 => "then(function(v){x=v})".to_string(),
            // Integer-returning handler: chains a fresh primitive downstream.
            1 => format!("then(function(v){{x=v;return {}}})", (b.next() % 20) as i32),
            // Pass-through `then()` — no handler, the value flows through.
            2 => "then()".to_string(),
            // `catch(h)` on a fulfilled promise: the handler never runs.
            _ => "catch(function(e){x=e})".to_string(),
        };
        chain.push('.');
        chain.push_str(&step);
    }
    format!("var x=0; {}{}; x", source, chain)
}

/// JS-escape a byte string as a double-quoted string-literal body (for
/// embedding a fuzzer-generated regexp source or subject into `new
/// RegExp("…")` / a method argument).
fn js_string_escape(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

/// Structure-aware generator for the **JavaScript RegExp surface** (child
/// 9/9): folds fuzzer bytes into a supported-grammar pattern + subject (via
/// [`gen_regexp`]) and emits a whole-program `new RegExp(pat, flags).<op>(subj)`
/// (or an accessor read), so the differential check pins the end-to-end run —
/// construction metering, the `exec`/`test` result shaping, and the computron
/// calibration — against the pin, not just the matcher. The generated grammar
/// stays inside the covered subset (no `g`/`y` stateful drive, no named groups,
/// ASCII subjects), so a divergence is a real finding; an out-of-subset pattern
/// the port names `Unsupported` is skipped honestly by the differential check.
/// Rides [`differential_check_with_symbols`] — the RegExp surface resolves
/// `exec`/`source`/`index`/… by their program-local symbol ids.
pub fn gen_stage3b_regexp_program(data: &[u8]) -> String {
    let (pattern, flags, subject, _start) = gen_regexp(data);
    // Drop any generated `g`/`y` flag: the stateful lastIndex drive needs the
    // code-unit↔byte remap this arm keeps out of scope. (gen_regexp does not
    // currently emit them, but guard so a future generator change stays safe.)
    let flags: String = flags.chars().filter(|c| *c != 'g' && *c != 'y').collect();
    let pat = js_string_escape(&pattern);
    let flg = js_string_escape(&flags);
    let subj = js_string_escape(&subject);
    // Pick the observed operation from a trailing byte (deterministic).
    let sel = data.last().copied().unwrap_or(0) % 12;
    let ctor = format!("new RegExp(\"{}\", \"{}\")", pat, flg);
    match sel {
        0 => format!("{}.exec(\"{}\")", ctor, subj),
        1 => format!("var m = {}.exec(\"{}\"); m ? m[0] : null", ctor, subj),
        2 => format!("var m = {}.exec(\"{}\"); m ? m.index : -1", ctor, subj),
        3 => format!("{}.test(\"{}\")", ctor, subj),
        4 => format!("{}.source", ctor),
        5 => format!("{}.flags", ctor),
        6 => format!("{}.toString()", ctor),
        // The String-side methods via the Symbol.search/Symbol.match/
        // Symbol.replace/Symbol.split protocol (the receiver is the subject
        // string, the argument the RegExp). The replacement is a literal (no
        // `$`); `split` runs without a limit (so no truncation corner).
        7 => format!("\"{}\".search({})", subj, ctor),
        8 => format!("\"{}\".match({})", subj, ctor),
        9 => format!("\"{}\".replace({}, \"R\")", subj, ctor),
        10 => format!("\"{}\".split({}).length", subj, ctor),
        _ => format!("var m = {}.exec(\"{}\"); m ? m.length : 0", ctor, subj),
    }
}

/// Structure-aware generator for **array spread** (`[...arr]`) — which
/// desugars to the for-of iterator loop appending each element. Emits a single
/// spread of a dense literal, optionally with leading/trailing plain elements,
/// then observes the result or its length. A single spread segment is
/// raw-exact against the pin (each additional segment carries a sub-computron
/// −8-raw residual from XS's item-chunk over-allocation, which never crosses a
/// computron boundary in a bounded program; kept single-segment here so the
/// arm is raw-clean). Rides the full symbol-linking differential check.
pub fn gen_stage3_spread_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    let n = (b.next() % 5) as usize; // 0..=4 spread elements
    let elems: Vec<String> = (0..n).map(|_| small_int(&mut b).to_string()).collect();
    let inner = format!("[{}]", elems.join(","));
    let lead = if b.choice(2) == 0 { format!("{},", small_int(&mut b)) } else { String::new() };
    let trail = if b.choice(2) == 0 { format!(",{}", small_int(&mut b)) } else { String::new() };
    let spread = format!("[{}...{}{}]", lead, inner, trail);
    match b.choice(3) {
        0 => spread,
        1 => format!("{}.length", spread),
        _ => format!("var b={}; b.length", spread),
    }
}

/// Structure-aware generator for **`for-in`** over an object literal or an
/// array — the computron-exact enumeration grammar (a sub-computron ±8-raw
/// chunk residual never crosses a `>> 16` boundary). Builds an object literal
/// (string keys) or a dense array and a count/concat loop over its keys. Rides
/// the full symbol-linking differential check.
pub fn gen_stage3_for_in_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    // The enumerable: either an object literal with 0..=3 single-letter string
    // keys, or a dense array of 0..=4 small ints.
    let target = if b.choice(2) == 0 {
        let n = (b.next() % 4) as usize;
        let mut props: Vec<String> = Vec::with_capacity(n);
        for i in 0..n {
            // Distinct keys a,b,c so the object is well-formed.
            let key = (b'a' + i as u8) as char;
            props.push(format!("{}:{}", key, small_int(&mut b)));
        }
        format!("{{{}}}", props.join(","))
    } else {
        let n = (b.next() % 5) as usize;
        let elems: Vec<String> = (0..n).map(|_| small_int(&mut b).to_string()).collect();
        format!("[{}]", elems.join(","))
    };
    if b.choice(2) == 0 {
        format!("var s=\"\"; for (var k in {}) s=s+k; s", target)
    } else {
        format!("var n=0; for (var k in {}) n=n+1; n", target)
    }
}

/// Structure-aware generator for the **re-entrant `Array.prototype.forEach`** —
/// the callback-taking method driven bit-exactly by `run_callback`. Builds a
/// dense array and a `forEach` whose callback accumulates over an outer
/// closed-over variable (`+`/`-`/`*`, overflow-safe), observing the result.
/// Rides the full symbol-linking differential check.
pub fn gen_stage3_reentrant_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    let n = (b.next() % 5) as usize; // 0..=4 dense elements
    let elems: Vec<String> = (0..n).map(|_| small_int(&mut b).to_string()).collect();
    let lit = format!("[{}]", elems.join(","));
    let thr = small_int(&mut b);
    match b.choice(12) {
        // forEach: accumulate the elements with an overflow-safe operator.
        0 => {
            let op = ["+", "-", "*"][b.choice(3) as usize];
            let seed = small_int(&mut b);
            format!("var s={}; {}.forEach(function(x){{s=s{}x}}); s", seed, lit, op)
        }
        // forEach: sum the indices.
        1 => format!("var s=0; {}.forEach(function(x,i){{s=s+i}}); s", lit),
        // forEach: count the elements.
        2 => format!("var n=0; {}.forEach(function(x){{n=n+1}}); n", lit),
        // map, joined so the result renders unambiguously.
        3 => format!("{}.map(function(x){{return x+1}}).join()", lit),
        // some / every over a threshold predicate.
        4 => format!("{}.some(function(x){{return x>{}}})", lit, thr),
        5 => format!("{}.every(function(x){{return x>{}}})", lit, thr),
        // find / findIndex over a threshold predicate.
        6 => format!("{}.find(function(x){{return x>{}}})", lit, thr),
        // filter, joined.
        7 => format!("{}.filter(function(x){{return x>{}}}).join()", lit, thr),
        // reduce with an initial value (safe on the empty array).
        8 => {
            let op = ["+", "-", "*"][b.choice(3) as usize];
            format!(
                "{}.reduce(function(a,x){{return a{}x}},{})",
                lit,
                op,
                small_int(&mut b)
            )
        }
        // reduceRight with an initial value.
        9 => format!(
            "{}.reduceRight(function(a,x){{return a+x}},{})",
            lit,
            small_int(&mut b)
        ),
        // findLast over a threshold predicate.
        10 => format!("{}.findLast(function(x){{return x<{}}})", lit, thr),
        // flatMap: return a small array per element, flattened + joined.
        _ => {
            if b.choice(2) == 0 {
                format!("{}.flatMap(function(x){{return [x,x]}}).join()", lit)
            } else {
                format!("{}.flatMap(function(x){{return x+{}}}).join()", lit, thr)
            }
        }
    }
}

/// Structure-aware generator for the **stage-3b keyed-collection iteration**
/// surface — Map/Set `forEach`, `entries`/`keys`/`values` iterators, and
/// `for-of` / spread over a Map or Set, every emitted program bit-exact (result
/// AND computron) against the pin. Builds a small Map or Set of distinct small
/// integer entries (so the covered `SameValueZero` / allocation path is
/// exercised without a mid-iteration mutation), then draws one observation:
/// a `forEach` accumulation, a stepped iterator, a `for-of` reduce/count, or a
/// spread length. Rides [`differential_check_with_symbols`] (the collection
/// intrinsics relink by name).
pub fn gen_stage3_collections_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    let is_set = b.choice(2) == 0;
    let n = (b.next() % 5) as usize; // 0..=4 distinct entries
    // Distinct integer keys 0..n so no in-place update perturbs the count; a
    // Map pairs each key with a small value.
    let ctor = if is_set { "Set" } else { "Map" };
    let mut build = format!("var c=new {}();", ctor);
    for i in 0..n {
        if is_set {
            build.push_str(&format!(" c.add({});", i));
        } else {
            build.push_str(&format!(" c.set({},{});", i, small_int(&mut b)));
        }
    }
    match b.choice(6) {
        // clear then observe the (zero) size, optionally re-adding one entry.
        5 => {
            if b.choice(2) == 0 {
                format!("{} c.clear(); c.size", build)
            } else if is_set {
                format!("{} c.clear(); c.add(9); c.size", build)
            } else {
                format!("{} c.clear(); c.set(9,9); c.get(9)", build)
            }
        }
        // forEach: accumulate the values with an overflow-safe operator.
        0 => {
            let op = small_op(&mut b);
            let seed = small_int(&mut b);
            format!("{} var s={}; c.forEach(function(v){{s=s{}v;}}); s", build, seed, op)
        }
        // forEach: count the entries.
        1 => format!("{} var k=0; c.forEach(function(){{k=k+1;}}); k", build),
        // A stepped iterator (values/keys/entries), observing value or done.
        2 => {
            let method = ["values", "keys", "entries"][b.choice(3) as usize];
            let advances = 1 + (b.next() as usize % (n + 2));
            let entries = method == "entries";
            let mut s = format!("{} var it=c.{}();", build, method);
            for i in 0..advances {
                if i + 1 < advances {
                    s.push_str(" it.next();");
                } else if entries {
                    // The entries yield is a `[k,v]` (Set: `[v,v]`) pair; read
                    // an element or `done`.
                    if b.choice(2) == 0 && n > 0 {
                        s.push_str(" var r=it.next(); r.done?-1:r.value[0]");
                    } else {
                        s.push_str(" it.next().done");
                    }
                } else if b.choice(2) == 0 {
                    s.push_str(" it.next().value");
                } else {
                    s.push_str(" it.next().done");
                }
            }
            s
        }
        // for-of: reduce or count (a Map yields `[k,v]` pairs).
        3 => {
            if is_set {
                let op = small_op(&mut b);
                let seed = small_int(&mut b);
                format!("{} var s={}; for (var x of c) s=s{}x; s", build, seed, op)
            } else {
                format!("{} var s=0; for (var e of c) s=s+e[0]+e[1]; s", build)
            }
        }
        // spread over the collection, observing the resulting array's length.
        _ => format!("{} var a=[...c]; a.length", build),
    }
}

/// A BigInt literal source token (`<decimal digits>n`), non-negative — a
/// negative BigInt is `-` over a literal, which the grammar composes
/// separately. Mixes single-limb values with occasional multi-limb magnitudes
/// so the generator exercises carry/borrow across the `txU4` boundary.
fn bigint_literal(b: &mut Bytes) -> String {
    match b.choice(5) {
        0 => "0n".to_string(),
        1 => format!("{}n", b.next() as u32), // 0..=255
        2 => format!("{}n", 4294967295u64 + b.next() as u64), // straddles 2^32
        3 => format!("{}n", 9007199254740991u64 + b.next() as u64), // past 2^53
        _ => format!("{}{}{}n", 1 + (b.next() % 9), b.next() % 10, b.next() % 10),
    }
}

/// A single BigInt operand: a literal, optionally negated (`-` over the
/// literal, XS's `fxBigInt_neg`).
fn bigint_operand(b: &mut Bytes) -> String {
    let lit = bigint_literal(b);
    if b.choice(3) == 0 {
        format!("(-{})", lit)
    } else {
        lit
    }
}

/// Stage-3b (bigint) grammar: BigInt literals, the metered `+`/`-`/`*`
/// (same-type only — a mixed BigInt/Number arithmetic op is a TypeError, so it
/// is deliberately never generated), unary minus, strict/loose equality
/// (including BigInt-vs-Number `==`/`!=`), both-BigInt relational order,
/// `typeof`, and decimal rendering — every form bit-exact (result AND
/// computron). Rides the plain [`differential_check`] (no built-in symbol
/// references appear). Composes an accumulation chain so the digit-step and
/// allocation metering ride the hot path.
pub fn gen_stage3_bigint_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    match b.choice(6) {
        // typeof over a (possibly negated) literal.
        0 => format!("typeof {}", bigint_operand(&mut b)),
        // A binary arithmetic op between two BigInt operands (same type).
        1 => {
            let op = small_op(&mut b);
            format!("{} {} {}", bigint_operand(&mut b), op, bigint_operand(&mut b))
        }
        // Strict/loose equality or relational between two BigInt operands.
        2 => {
            let cmp = ["===", "!==", "<", ">", "<=", ">="][b.choice(6) as usize];
            format!("{} {} {}", bigint_operand(&mut b), cmp, bigint_operand(&mut b))
        }
        // Loose equality of a BigInt with a Number (fxNumberToBigInt path).
        3 => {
            let cmp = if b.choice(2) == 0 { "==" } else { "!=" };
            format!("{} {} {}", bigint_operand(&mut b), cmp, b.next() % 20)
        }
        // A three-operand arithmetic chain (carry/borrow/product hot path).
        4 => {
            let (o1, o2) = (small_op(&mut b), small_op(&mut b));
            format!(
                "{} {} {} {} {}",
                bigint_operand(&mut b),
                o1,
                bigint_operand(&mut b),
                o2,
                bigint_operand(&mut b)
            )
        }
        // A var accumulation loop-body unrolled: repeated compound updates.
        _ => {
            let seed = bigint_literal(&mut b);
            let steps = 1 + (b.next() % 4);
            let mut s = format!("var x={};", seed);
            for _ in 0..steps {
                let op = small_op(&mut b);
                s.push_str(&format!(" x = x {} {};", op, bigint_operand(&mut b)));
            }
            s.push_str(" x");
            s
        }
    }
}

/// Stage-3b binary-data grammar (child 3/9): the ArrayBuffer construct +
/// `byteLength` accessor surface that is **bit-exact** (result AND
/// computron) against XS. Every arm builds `new ArrayBuffer(n)` over a
/// spread of byte lengths (so the 8-byte chunk-alignment boundary is
/// crossed) and reads `.byteLength`, exercising the constant native frame
/// plus the `fxNewChunk(n)` backing store. Rides the full symbol-linking
/// differential check (the `ArrayBuffer` global and the `byteLength` name
/// are program symbols).
pub fn gen_stage3b_binary_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    // A byte length that reaches both sides of an 8-byte alignment boundary.
    let len = |b: &mut Bytes| -> u32 {
        match b.choice(4) {
            0 => (b.next() % 8) as u32,
            1 => (b.next() % 64) as u32,
            2 => (b.next() as u32) + 1,
            _ => ((b.next() as u32) % 512) + 256,
        }
    };
    // The concrete numeric TypedArray element types (the BigInt views are
    // excluded — their element read/write self-names until BigInt coercion
    // lands). Paired with a small element count.
    const TA: &[&str] = &[
        "Uint8Array", "Int8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
        "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
    ];
    let ta = |b: &mut Bytes| -> &'static str { TA[(b.next() as usize) % TA.len()] };
    let count = |b: &mut Bytes| -> u32 { 1 + (b.next() as u32 % 6) };
    // DataView element type methods paired with their byte width.
    const DV: &[(&str, u32)] = &[
        ("Int8", 1), ("Uint8", 1), ("Int16", 2), ("Uint16", 2),
        ("Int32", 4), ("Uint32", 4), ("Float32", 4), ("Float64", 8),
    ];
    match b.choice(11) {
        // Construct and read the byteLength directly.
        0 => format!("new ArrayBuffer({}).byteLength", len(&mut b)),
        // A missing argument defaults the byteLength to 0.
        1 => "new ArrayBuffer().byteLength".to_string(),
        // Bind to a variable, then read the byteLength back.
        2 => {
            let n = len(&mut b);
            format!("var a = new ArrayBuffer({}); a.byteLength", n)
        }
        // typeof an ArrayBuffer instance ("object").
        3 => format!("typeof new ArrayBuffer({})", len(&mut b)),
        // Two independent buffers; sum their byte lengths.
        4 => {
            let (m, n) = (len(&mut b), len(&mut b));
            format!(
                "var p = new ArrayBuffer({}); var q = new ArrayBuffer({}); p.byteLength + q.byteLength",
                m, n
            )
        }
        // Length-form TypedArray construct + a length/byteLength accessor.
        5 => {
            let acc = if b.choice(2) == 0 { "length" } else { "byteLength" };
            format!("new {}({}).{}", ta(&mut b), count(&mut b), acc)
        }
        // Element write then read at an in-bounds index.
        6 => {
            let n = count(&mut b);
            let idx = (b.next() as u32) % n;
            let val = (b.next() as i32) - 128;
            format!(
                "var a = new {}({}); a[{}] = {}; a[{}]",
                ta(&mut b),
                n,
                idx,
                val,
                idx
            )
        }
        // Buffer-form construct: a view over an existing ArrayBuffer.
        7 => {
            let words = 1 + (b.next() as u32 % 4);
            format!(
                "var b = new ArrayBuffer({}); new Int32Array(b).length",
                words * 4
            )
        }
        // Fill a small typed array in a loop and sum it (the metering hot path).
        8 => {
            let n = count(&mut b);
            format!(
                "var a = new {}({}); var i = 0; while (i < {}) {{ a[i] = i; i = i + 1; }} a[0]",
                ta(&mut b),
                n,
                n
            )
        }
        // DataView construct + endian-aware set/get round-trip.
        9 => {
            let (suffix, width) = DV[(b.next() as usize) % DV.len()];
            let cap = 8u32;
            let off = (b.next() as u32) % (cap - width + 1);
            let le = if b.choice(2) == 0 { "" } else { ", true" };
            let val = (b.next() as i32) - 128;
            format!(
                "var d = new DataView(new ArrayBuffer({})); d.set{}({}, {}{}); d.get{}({}{})",
                cap, suffix, off, val, le, suffix, off, le
            )
        }
        // DataView accessors / isView.
        _ => {
            let cap = 4 + 4 * ((b.next() as u32) % 4);
            match b.choice(3) {
                0 => format!("new DataView(new ArrayBuffer({})).byteLength", cap),
                1 => {
                    let off = (b.next() as u32) % (cap + 1);
                    format!("new DataView(new ArrayBuffer({}), {}).byteOffset", cap, off)
                }
                _ => format!("ArrayBuffer.isView(new DataView(new ArrayBuffer({})))", cap),
            }
        }
    }
}

/// Stage-3b fundamentals-followup grammar (child 4/9): the post-arrays
/// fundamentals surfaces that are **bit-exact** (result AND computron) vs
/// XS — a user function's `.length`/`.name`, `Function.prototype.bind`
/// (create + call), `Function.prototype.apply` with a dense array,
/// `Symbol.prototype.toString`/`String(symbol)`/`Symbol.for`/`keyFor`, and
/// `AggregateError`. Every arm is a valid, always-bit-exact program (the
/// honest-skip corners — `new boundFn`, a primitive `this`, a sparse array,
/// a non-array apply argument, a bound-of-bound *call* — are deliberately not
/// generated). Rides [`differential_check_with_symbols`] (the built-ins and
/// property names relink by program symbol).
pub fn gen_stage3b_fundamentals_followup_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    // A small non-negative integer literal for bound/call/apply arguments.
    let n = |b: &mut Bytes| -> i32 { (b.next() % 20) as i32 };
    // A short identifier-safe key string for the Symbol registry.
    let key = |b: &mut Bytes| -> String {
        const K: &[&str] = &["k", "a", "reg", "sym", "x1", "hello"];
        K[(b.next() as usize) % K.len()].to_string()
    };
    match b.choice(10) {
        // A user function's `.length` (its declared arity).
        0 => {
            let arity = (b.next() % 6) as usize;
            let params: Vec<String> = (0..arity).map(|i| format!("p{}", i)).collect();
            format!("function f({}){{return 0}} f.length", params.join(","))
        }
        // A user function's `.name` (declaration and var-initializer forms).
        1 => {
            if b.choice(2) == 0 {
                "function namedFn(a){return a} namedFn.name".to_string()
            } else {
                "var vf = function(x,y){return x}; vf.name".to_string()
            }
        }
        // `Function.prototype.bind` — create then call (0..2 bound args).
        2 => {
            let nb = (b.next() % 3) as usize;
            let bound: Vec<String> = (0..nb).map(|_| n(&mut b).to_string()).collect();
            let call: Vec<String> = (0..(1 + b.next() % 3))
                .map(|_| n(&mut b).to_string())
                .collect();
            let bound_list = if bound.is_empty() {
                "undefined".to_string()
            } else {
                format!("undefined,{}", bound.join(","))
            };
            format!(
                "function ft(a,b,c){{return a+b+c}} var g = ft.bind({}); g({})",
                bound_list,
                call.join(",")
            )
        }
        // `bind`'s bound `.length` / `.name`.
        3 => {
            let nb = (b.next() % 4) as usize;
            let bound: Vec<String> = (0..nb).map(|_| n(&mut b).to_string()).collect();
            let bound_list = if bound.is_empty() {
                "undefined".to_string()
            } else {
                format!("undefined,{}", bound.join(","))
            };
            let acc = if b.choice(2) == 0 { "length" } else { "name" };
            format!(
                "function fq(a,b,c,d){{return 0}} fq.bind({}).{}",
                bound_list, acc
            )
        }
        // `Function.prototype.apply` with a dense array argument.
        4 => {
            let cnt = 1 + (b.next() % 4) as usize;
            let elems: Vec<String> = (0..cnt).map(|_| n(&mut b).to_string()).collect();
            format!(
                "function fa(a,b,c){{return a+b+c}} fa.apply(undefined,[{}])",
                elems.join(",")
            )
        }
        // `Symbol.prototype.toString` / `String(symbol)`.
        5 => {
            let desc = key(&mut b);
            match b.choice(3) {
                0 => format!("Symbol(\"{}\").toString()", desc),
                1 => "Symbol().toString()".to_string(),
                _ => format!("String(Symbol(\"{}\"))", desc),
            }
        }
        // `Symbol.for` / `Symbol.keyFor` (the registry).
        6 => {
            let k = key(&mut b);
            match b.choice(3) {
                0 => format!("Symbol.for(\"{}\")===Symbol.for(\"{}\")", k, k),
                1 => format!("Symbol.keyFor(Symbol.for(\"{}\"))", k),
                _ => format!("typeof Symbol.keyFor(Symbol(\"{}\"))", k),
            }
        }
        // `AggregateError` (dense-array errors form).
        7 => {
            let cnt = (b.next() % 4) as usize;
            let elems: Vec<String> = (0..cnt).map(|_| n(&mut b).to_string()).collect();
            match b.choice(3) {
                0 => format!("new AggregateError([{}]).errors.length", elems.join(",")),
                1 => "new AggregateError([], \"boom\").message".to_string(),
                _ => format!("new AggregateError([{}]).name", elems.join(",")),
            }
        }
        // A bound function in CALLBACK position: it must trampoline through
        // the target (dispatch the target with the bound this/args prepended),
        // NOT re-execute the program from pc 0 (the whole-program-from-pc-0
        // abort / divergent completion this arm regresses). Emits the
        // bit-exact callback-driving Array-method sites over a bound callback,
        // with 0 or 1 bound leading args.
        8 => {
            let bound_list = if b.choice(2) == 0 {
                "null".to_string()
            } else {
                format!("null,{}", n(&mut b))
            };
            let cnt = 1 + (b.next() % 3) as usize;
            let elems: Vec<String> = (0..cnt).map(|_| n(&mut b).to_string()).collect();
            let arr = format!("[{}]", elems.join(","));
            match b.choice(4) {
                0 => format!("function cf(a,b){{return a+b}} {}.map(cf.bind({}))", arr, bound_list),
                1 => format!("function cf(a,b){{return a+b}} {}.forEach(cf.bind({}))", arr, bound_list),
                2 => format!("function cf(a,b){{return b>0}} {}.filter(cf.bind({}))", arr, bound_list),
                _ => format!("function cf(a,b){{return a+b}} {}.reduce(cf.bind({}))", arr, bound_list),
            }
        }
        // A bind round-trip through `this`.
        _ => {
            let v = n(&mut b);
            format!(
                "function fthis(){{return this.v}} var o = {{v: {}}}; var g = fthis.bind(o); g()",
                v
            )
        }
    }
}

/// Stage-3b object-statics + intern-table differential arm (child 5/9): a
/// random small ordinary object exercised through `hasOwnProperty`,
/// `Object.keys`, and `Object.getOwnPropertyDescriptor` over both present
/// (program-symbol) keys and absent keys — the genuinely-novel and the
/// pre-interned-default-key forms — so the arm rides the intern table's
/// metering split (a novel key meters one `fxNewSlot`; a default key none) and
/// the descriptor build. Rides the full symbol-linking
/// [`differential_check_with_symbols`] (result AND computron).
pub fn gen_stage3b_object_statics_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    // The property-name pool: program-symbol keys used in the object literal.
    const PRESENT: &[&str] = &["a", "b", "c", "foo", "bar", "q"];
    // Keys that are NOT in the literal: a genuinely-novel name and pre-interned
    // default keys (well-known inherited names) — both absent as OWN properties.
    const ABSENT: &[&str] = &["zzz", "missing", "toString", "valueOf", "hasOwnProperty"];
    // Build an object literal with 0..4 distinct present keys.
    let count = (b.next() % 5) as usize;
    let mut keys: Vec<&str> = Vec::new();
    for _ in 0..count {
        let k = PRESENT[(b.next() as usize) % PRESENT.len()];
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    let fields: Vec<String> = keys
        .iter()
        .enumerate()
        .map(|(i, k)| format!("{}:{}", k, i + 1))
        .collect();
    let obj = format!("{{{}}}", fields.join(","));
    // Pick a present key (if any) or fall back to an absent probe.
    let present_key = keys
        .get((b.next() as usize).wrapping_rem(keys.len().max(1)))
        .copied();
    let absent_key = ABSENT[(b.next() as usize) % ABSENT.len()];
    // Genuinely-novel names (absent from XS's boot key table AND the literal)
    // — a computed read/`hasOwnProperty` of one is bit-exact `undefined`/false,
    // interning exactly one key slot. A boot default key (`toString`, …) read
    // by a *computed* key self-names (ironhorse cannot tell an unlinked inherited
    // built-in from an absent own), so the computed-access arms draw only from
    // this novel pool to stay on the covered path.
    const NOVEL: &[&str] = &["zzz", "missing", "qux", "wibble", "novelkey"];
    let novel_key = NOVEL[(b.next() as usize) % NOVEL.len()];
    // Fresh keys for `Object.defineProperty` — disjoint from `PRESENT` (so a
    // define is always a NEW property, never a self-naming redefine) and read
    // back statically (so each is a program symbol `Object.keys` can render).
    const DEFKEY: &[&str] = &["dp", "dr", "ds", "dt"];
    let def_key = DEFKEY[(b.next() as usize) % DEFKEY.len()];
    let def_w = b.next() & 1 == 0;
    let def_e = b.next() & 1 == 0;
    let def_c = b.next() & 1 == 0;
    let def_desc = format!(
        "{{value:7,writable:{},enumerable:{},configurable:{}}}",
        def_w, def_e, def_c
    );
    match b.choice(12) {
        // hasOwnProperty over a present key.
        0 => match present_key {
            Some(k) => format!("var o={}; o.hasOwnProperty(\"{}\")", obj, k),
            None => format!("var o={}; o.hasOwnProperty(\"{}\")", obj, absent_key),
        },
        // hasOwnProperty over an absent key (novel or default).
        1 => format!("var o={}; o.hasOwnProperty(\"{}\")", obj, absent_key),
        // Object.keys length.
        2 => format!("var o={}; Object.keys(o).length", obj),
        // Object.keys first element (or length when empty).
        3 => {
            if keys.is_empty() {
                format!("var o={}; Object.keys(o).length", obj)
            } else {
                format!("var o={}; Object.keys(o)[0]", obj)
            }
        }
        // getOwnPropertyDescriptor of a present key: read one attribute.
        4 => match present_key {
            Some(k) => {
                let attr = match b.choice(4) {
                    0 => "value",
                    1 => "writable",
                    2 => "enumerable",
                    _ => "configurable",
                };
                format!(
                    "var o={}; Object.getOwnPropertyDescriptor(o,\"{}\").{}",
                    obj, k, attr
                )
            }
            None => format!(
                "var o={}; typeof Object.getOwnPropertyDescriptor(o,\"{}\")",
                obj, absent_key
            ),
        },
        // getOwnPropertyDescriptor of an absent key: undefined.
        5 => format!(
            "var o={}; typeof Object.getOwnPropertyDescriptor(o,\"{}\")",
            obj, absent_key
        ),
        // Computed string member read `o[k]` of a present key via the
        // interning AT opcode: reads the own value (a program symbol, no
        // slot allocated).
        6 => match present_key {
            Some(k) => format!("var o={}; var k=\"{}\"; o[k]", obj, k),
            None => format!("var o={}; var k=\"{}\"; typeof o[k]", obj, novel_key),
        },
        // Computed string member read of a genuinely-novel key: interns one
        // key slot and reads bit-exact `undefined` (absent-own, no inherited).
        8 => format!("var o={}; var k=\"{}\"; typeof o[k]", obj, novel_key),
        // `key in o` for a present key ⇒ `true` (an own-hit chain walk).
        9 => match present_key {
            Some(k) => format!("var o={}; \"{}\" in o", obj, k),
            None => format!("var o={}; \"{}\" in o", obj, novel_key),
        },
        // `key in o` for a genuinely-novel key ⇒ sound `false` — the walk
        // exhausts the chain and interns one key slot.
        7 => format!("var o={}; \"{}\" in o", obj, novel_key),
        // `Object.defineProperty` a new data property, then read the value
        // back (the key is a program symbol via the static read).
        10 => format!(
            "var o={}; Object.defineProperty(o,\"{}\",{}); o.{}",
            obj, def_key, def_desc, def_key
        ),
        // `Object.defineProperty` then read one attribute back through
        // `getOwnPropertyDescriptor` (the flag → descriptor readback).
        _ => {
            let attr = match b.choice(3) {
                0 => "writable",
                1 => "enumerable",
                _ => "configurable",
            };
            format!(
                "var o={}; Object.defineProperty(o,\"{}\",{}); var d=Object.getOwnPropertyDescriptor(o,\"{}\"); d.{}",
                obj, def_key, def_desc, def_key, attr
            )
        }
    }
}

fn gen_atom(b: &mut Bytes) -> String {
    match b.choice(6) {
        0 => "true".to_string(),
        1 => "false".to_string(),
        2 => {
            // small signed integer
            let v = b.next() as i32 - 128;
            format!("{}", v)
        }
        3 => {
            // larger integer near i32 edges to exercise overflow
            let v = (b.next() as i64) << 23;
            format!("{}", v)
        }
        4 => {
            // a decimal
            let a = b.next() % 100;
            let c = b.next() % 100;
            format!("{}.{}", a, c)
        }
        _ => format!("{}", b.next() % 10),
    }
}

/// A differential divergence found by target 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Divergence {
    pub source: String,
    pub detail: String,
}

/// Whether two completion result strings denote the same guest value.
///
/// Byte-identical strings agree. Beyond that, a **Number** completion is
/// compared by its IEEE-754 double rather than its decimal spelling. XS's
/// `fx_dtoa` renders some large integer-valued doubles in a non-shortest,
/// exact-integer form — finding `d99d263fcf6ca7a7` reproduced
/// `327155712 * ((327155712 * (729808896 % 603979776)) % 729808896)`, whose
/// value is the exactly-representable double `57632001481506816`, which XS
/// prints verbatim (17 digits). ironhorse — like V8/SpiderMonkey and
/// ECMA-262 §6.1.6.1.20's "k is as small as possible" — prints the *shortest*
/// round-tripping decimal, `57632001481506820` (16 digits). Both spellings
/// parse back to the identical double, so the two engines computed the same
/// value and disagree only on rendering; forcing byte-identity would make
/// ironhorse reproduce XS's non-shortest, non-conformant rendering.
///
/// Comparing the parsed doubles suppresses that spurious spelling divergence
/// while still flagging every genuine value divergence: two *different*
/// doubles never share a parse (a decimal string parses to exactly one
/// nearest double), so `a.to_bits() == b.to_bits()` fails the moment the
/// engines actually computed different numbers.
fn results_agree(oracle: &str, ironhorse: &str) -> bool {
    if oracle == ironhorse {
        return true;
    }
    match (as_ecma_number(oracle), as_ecma_number(ironhorse)) {
        (Some(a), Some(b)) => a.to_bits() == b.to_bits(),
        _ => false,
    }
}

/// Parse a completion string as the ECMAScript `String()` of a finite
/// Number, or `None` when it is not a plain decimal Number spelling — so
/// `"Infinity"`, `"NaN"`, booleans, and string results fall through to the
/// byte comparison in [`results_agree`] (and `Infinity`/`NaN` already match
/// byte-for-byte anyway). The character allow-list is what keeps Rust's
/// float parser from accepting `inf`/`nan`/`infinity`, which JS never prints.
fn as_ecma_number(s: &str) -> Option<f64> {
    if s.is_empty() {
        return None;
    }
    if !s
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return None;
    }
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Target 1 body: run `source` on both engines, returning `Err` on any
/// completion / result / computron divergence. `Ok(())` also covers the
/// legitimate "ironhorse reached an opcode outside the stage-1 subset" case
/// (a generated program using an unimplemented feature is not a
/// correctness bug), which keeps the target honest about scope.
pub fn differential_check(source: &str) -> Result<(), Divergence> {
    let oracle = match xs_oracle::run(source) {
        Some(o) => o,
        None => return Ok(()), // machine startup failure, not a finding
    };
    let ironhorse = run_program(&oracle.bytecode);

    // Out-of-subset opcode: not a divergence, just uncovered ground.
    if let ironhorse_vm::Halt::Unsupported(_) = ironhorse.halt {
        return Ok(());
    }

    if oracle.completed != ironhorse.completed {
        return Err(Divergence {
            source: source.to_string(),
            detail: format!(
                "completion: oracle={} ironhorse={} (halt {:?})",
                oracle.completed, ironhorse.completed, ironhorse.halt
            ),
        });
    }
    if oracle.completed {
        if !results_agree(&oracle.result, &ironhorse.result) {
            return Err(Divergence {
                source: source.to_string(),
                detail: format!("result: oracle={:?} ironhorse={:?}", oracle.result, ironhorse.result),
            });
        }
        if oracle.computrons != ironhorse.computrons {
            return Err(Divergence {
                source: source.to_string(),
                detail: format!(
                    "computrons: oracle={} ironhorse={}",
                    oracle.computrons, ironhorse.computrons
                ),
            });
        }
    }
    Ok(())
}

/// Differential check that **links the program's symbol table** before
/// running on ironhorse (`run_program_with_symbols`), the full result+computron
/// comparison. Required for any grammar whose bytecode references a named
/// property or intrinsic the engine must recognize by name — the stage-3
/// arrays surface needs it so `length` routes to the array length semantics
/// (a bare [`differential_check`] runs without symbols, where `arr.length`
/// would be read as an ordinary numeric-id property and diverge).
pub fn differential_check_with_symbols(source: &str) -> Result<(), Divergence> {
    let oracle = match xs_oracle::run(source) {
        Some(o) => o,
        None => return Ok(()),
    };
    let ironhorse = ironhorse_vm::run_program_with_symbols(&oracle.bytecode, &oracle.symbols);
    if let ironhorse_vm::Halt::Unsupported(_) = ironhorse.halt {
        return Ok(());
    }
    // The oracle captures the completion value into a fixed-size buffer; when
    // the value is longer than that buffer, `oracle.result` is a truncated
    // prefix and cannot be compared against the port's full result without a
    // spurious divergence (finding 493390fc03979205: a deeply nested regexp
    // whose `.toString()` exceeds the buffer). The oracle cannot faithfully
    // represent this result, so skip honestly, exactly like an out-of-subset
    // program — never report the truncation as a port defect.
    if oracle.result_truncated {
        return Ok(());
    }
    if oracle.completed != ironhorse.completed {
        return Err(Divergence {
            source: source.to_string(),
            detail: format!(
                "completion: oracle={} ironhorse={} (halt {:?})",
                oracle.completed, ironhorse.completed, ironhorse.halt
            ),
        });
    }
    if oracle.completed {
        if !results_agree(&oracle.result, &ironhorse.result) {
            return Err(Divergence {
                source: source.to_string(),
                detail: format!("result: oracle={:?} ironhorse={:?}", oracle.result, ironhorse.result),
            });
        }
        if oracle.computrons != ironhorse.computrons {
            return Err(Divergence {
                source: source.to_string(),
                detail: format!(
                    "computrons: oracle={} ironhorse={}",
                    oracle.computrons, ironhorse.computrons
                ),
            });
        }
    }
    Ok(())
}

/// Differential check for the **stage-2 allocating surface**: compares
/// completion kind and result string, but not computrons, which are not
/// yet bit-exact while run-time slot/chunk allocation metering awaits
/// the faithful heap (`ironhorse_vm::interp` § Metering scope). A result or
/// completion divergence on a valid generated program is still a real
/// finding — the frame/scope/loop semantics must match XS.
pub fn differential_check_result_only(source: &str) -> Result<(), Divergence> {
    let oracle = match xs_oracle::run(source) {
        Some(o) => o,
        None => return Ok(()),
    };
    let ironhorse = run_program(&oracle.bytecode);
    if let ironhorse_vm::Halt::Unsupported(_) = ironhorse.halt {
        return Ok(());
    }
    // A completion value longer than the oracle's fixed capture buffer is a
    // truncated prefix on the oracle side; comparing it against the port's
    // full result would be a spurious divergence, so skip honestly (see
    // `differential_check_with_symbols`, finding 493390fc03979205).
    if oracle.result_truncated {
        return Ok(());
    }
    if oracle.completed != ironhorse.completed {
        return Err(Divergence {
            source: source.to_string(),
            detail: format!(
                "completion: oracle={} ironhorse={} (halt {:?})",
                oracle.completed, ironhorse.completed, ironhorse.halt
            ),
        });
    }
    if oracle.completed && !results_agree(&oracle.result, &ironhorse.result) {
        return Err(Divergence {
            source: source.to_string(),
            detail: format!("result: oracle={:?} ironhorse={:?}", oracle.result, ironhorse.result),
        });
    }
    Ok(())
}

/// A dispatch-count ceiling for the decoder fuzz harness. The un-metered
/// [`run_program`] is not total on arbitrary bytecode — a malformed
/// backward branch that targets itself (e.g. `BRANCH_STATUS_1` with offset
/// `-2` at pc 0, decoded from seed 1750 of
/// [`decoder_never_panics_on_arbitrary_bytes`]) spins forever with no
/// metering host armed to refuse it. Bounding execution turns any such hang
/// into a [`ironhorse_vm::Halt::StepLimit`] in milliseconds. The bound is far
/// above any well-formed `<= 40`-byte fuzz program's dispatch count, so it
/// only ever fires on a genuine non-terminating cycle.
pub const DECODER_STEP_LIMIT: u64 = 2_000_000;

/// Target 2 body: the decoder and interpreter must not panic **or hang** on
/// arbitrary bytes. Returns the disassembled length so a caller can assert
/// liveness; the point is simply that it returns — in bounded time.
pub fn decoder_is_panic_free(bytes: &[u8]) -> usize {
    let dis = disassemble(bytes);
    // The interpreter must also degrade gracefully — a `Halt::Decode` on a
    // truncated/invalid stream, a bounded `Halt::StepLimit` on a
    // non-terminating dispatch cycle — never panic and never hang. The
    // bounded entry is the wedge-proofing: without it a self-targeting
    // backward branch would spin the whole test binary forever (the
    // stage-4a decoder-hang regression).
    let _ = run_program_bounded(bytes, DECODER_STEP_LIMIT);
    dis.len()
}

// ======================= stage-5 compiler fuzzing =======================
//
// Two targets over `ironhorse-compile`, the stage-5 pure-Rust compiler
// (design § roadmap row 5; Fuzzability). Both keep their substance here in
// the `forbid(unsafe_code)` lib so they build and unit-test without a
// libFuzzer toolchain.
//
//  - **Parser fuzz** ([`parse_is_panic_free`]): a structure-aware program
//    (or arbitrary bytes) driven through `ironhorse_compile::Parser`, which
//    must return a `Result` — a structured `ParseError`/`LexError`, never
//    a panic. Totality of the parser is the invariant the whole compiler
//    (scoper, coder) and the differential target below lean on.
//  - **Compile differential** ([`compile_differential_check`]): the same
//    source through `ironhorse_compile::compile` and the XS oracle compiler,
//    comparing accept/reject agreement and — on accepts — byte identity.
//    An oracle process crash (`run` returns `None`) is a NAMED outcome
//    ([`CompileFuzzOutcome::OracleUnavailable`]), not a harness abort.

/// A structure-aware source program for the compiler fuzz targets. Folds
/// raw fuzzer bytes into a program drawn from the richest generators the
/// corpus has — statements, the stage-2b object/call/closure/exception
/// surface, and (for coverage of the operator grammar) a bare expression.
pub fn gen_compile_program(data: &[u8]) -> String {
    let mut b = Bytes::new(data);
    match b.choice(4) {
        0 => gen_program(data),
        1 => gen_statement_program(data),
        2 => gen_stage2b_program(data),
        _ => gen_object_program(&mut b),
    }
}

/// **Parser fuzz target body.** `source` must drive the parser to a
/// `Result` — an accept or a *structured* rejection — never a panic and
/// never a hang (the parser is finite over finite input). Returns `true`
/// if the parser accepted, `false` if it rejected; either is a valid
/// outcome. The property the fuzzer enforces is simply that this function
/// *returns* (a panic aborts the libFuzzer run and is the finding).
///
/// Both a Script and a Module goal are attempted so the module-only
/// grammar (`import`/`export`) is on the fuzzed surface too.
pub fn parse_is_panic_free(source: &str) -> bool {
    let script = parse_once(source, false, false);
    let _module = parse_once(source, false, true);
    script
}

fn parse_once(source: &str, strict: bool, module: bool) -> bool {
    match ironhorse_compile::Parser::new(source, strict, module) {
        Ok(mut p) => p.parse_program(strict).is_ok(),
        Err(_) => false, // a lex error before the first token is a rejection
    }
}

/// The outcome of one compile-differential comparison. Every arm is a
/// NAMED, non-aborting classification — including an oracle process crash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompileFuzzOutcome {
    /// Both accept; bytes are byte-identical (the bar holds).
    Identical,
    /// Both accept; bytes differ — a real finding.
    ByteDivergence { detail: String },
    /// Both reject (accept/reject agreement in the reject direction).
    BothReject,
    /// The oracle accepted but ironhorse rejected (a coder/parser fold) — a
    /// finding for the accept/reject bar.
    IronhorseRejected { detail: String },
    /// ironhorse accepted but the oracle rejected — a finding.
    OracleRejected,
    /// The oracle machine failed to start (`run` returned `None`) — a
    /// NAMED outcome, never a harness abort.
    OracleUnavailable,
}

/// **Compile-differential fuzz target body.** Compile `source` on ironhorse and
/// the XS oracle; classify accept/reject agreement and, on a shared
/// accept, byte identity. `Ok(outcome)` is always returned (never a panic
/// escaping): a coder fold is caught and named `IronhorseRejected`, an oracle
/// crash is named `OracleUnavailable`. The libFuzzer wrapper turns a
/// `ByteDivergence` / `IronhorseRejected` / `OracleRejected` into the finding.
pub fn compile_differential_check(source: &str) -> CompileFuzzOutcome {
    let oracle = match xs_oracle::run(source) {
        Some(o) => o,
        None => return CompileFuzzOutcome::OracleUnavailable,
    };
    // The oracle "accepted" (parsed) unless it aborted with a SyntaxError.
    let oracle_accepts = oracle.completed || !oracle.error.contains("SyntaxError");

    // The coder still `panic!`s on unported constructs; catch it so a fold
    // is a named rejection, not a fuzzer abort.
    let ironhorse = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ironhorse_compile::compile(source)
    }));
    let ironhorse_bytes: Option<Vec<u8>> = match &ironhorse {
        Ok(Ok(b)) => Some(b.clone()),
        _ => None,
    };

    match (oracle_accepts, ironhorse_bytes) {
        (true, Some(bytes)) => {
            if bytes == oracle.bytecode {
                CompileFuzzOutcome::Identical
            } else {
                CompileFuzzOutcome::ByteDivergence {
                    detail: format!(
                        "len oracle={} ironhorse={}",
                        oracle.bytecode.len(),
                        bytes.len()
                    ),
                }
            }
        }
        (true, None) => {
            let detail = match ironhorse {
                Ok(Err(e)) => format!("parse/scope reject: {:?}", e),
                Err(_) => "coder panic (ported-surface fold)".to_string(),
                _ => unreachable!(),
            };
            CompileFuzzOutcome::IronhorseRejected { detail }
        }
        (false, Some(_)) => CompileFuzzOutcome::OracleRejected,
        (false, None) => CompileFuzzOutcome::BothReject,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression for continuous-fuzz finding `66facfd52ae8c673` (target
    /// `differential_source`). The exact 3-byte minimized input folds into
    /// arithmetic whose result is the exactly representable double
    /// `51298825763029616`. XS renders that exact integer while ironhorse uses
    /// the shorter round-tripping decimal `51298825763029620`; both strings
    /// parse to the same `f64`. This is the same oracle-rendering class as
    /// finding `d99d263fcf6ca7a7`, so the numeric `results_agree` comparison
    /// must suppress the false divergence.
    #[test]
    fn finding_66facfd52ae8c673_large_integer_dtoa_agrees() {
        let data: &[u8] = include_bytes!(
            "../tests/fixtures/finding-66facfd52ae8c673.input.bin"
        );
        assert_eq!(
            data.len(),
            3,
            "the minimized finding remains exactly three bytes"
        );

        let program = gen_program(data);
        match differential_check(&program) {
            Ok(()) => {}
            Err(divergence) => panic!(
                "finding 66facfd52ae8c673 must not diverge: {:?}",
                divergence
            ),
        }
    }

    /// Regression for continuous-fuzz finding `d99d263fcf6ca7a7` (target
    /// `differential_source`). The 5-byte input `2d 57 27 48 86` folds into
    /// `((729808896 && …) * ((… * (729808896 % 603979776)) % 729808896))`,
    /// whose value is the exactly-representable double `57632001481506816`.
    /// XS's `fx_dtoa` prints that double verbatim as its 17-digit exact
    /// integer, whereas ironhorse — like V8 and ECMA-262 §6.1.6.1.20's
    /// shortest-round-tripping rule — prints the 16-digit `57632001481506820`.
    /// Both denote the identical double, so the engines agree on the value and
    /// diverge only on decimal spelling; the differential check must not read
    /// that as a finding.
    #[test]
    fn finding_d99d263fcf6ca7a7_large_integer_dtoa_agrees() {
        // The exact minimized fuzz input (sha256
        // 749f2021f82cf2664d886690b5e87184f084e600df531f9ab232e3f64e09a4f9).
        let data: &[u8] = &[0x2d, 0x57, 0x27, 0x48, 0x86];
        let prog = gen_program(data);
        // Confirm we are still exercising the finding: the generated program
        // is the large-integer arithmetic whose value overflows 2^53.
        assert!(prog.contains('*'), "finding program is a product: {}", prog);
        match differential_check(&prog) {
            Ok(()) => {}
            Err(d) => panic!("finding d99d263fcf6ca7a7 must not diverge: {:?}", d),
        }
    }

    /// Regression for continuous-fuzz finding `5c29667cc15d6d93` (target
    /// `differential_source`). The 5-byte input `e1 1b dc dc dc` folds into
    /// `((-(-(-226492416))) * (-(-(-226492416))))`, i.e. `226492416^2` where
    /// `226492416 = 27 * 2^23`, whose value is the exactly-representable double
    /// `729 * 2^46` = `51298814505517056`. XS's `fx_dtoa` prints that double
    /// verbatim as its 17-digit exact integer, whereas ironhorse — like V8 and
    /// ECMA-262 §6.1.6.1.20's shortest-round-tripping rule — prints
    /// `51298814505517060`. Both denote the identical double, so the engines
    /// agree on the value and diverge only on decimal spelling; the same class
    /// as `d99d263fcf6ca7a7`, already suppressed by the numeric `results_agree`
    /// comparison. The differential check must not read this as a finding.
    #[test]
    fn finding_5c29667cc15d6d93_large_integer_dtoa_agrees() {
        // The exact minimized fuzz input (sha256
        // 203db557fe4893accc7f29b36e0fc723551a7494f0c33a65e809ec88045449e2).
        let data: &[u8] = &[0xe1, 0x1b, 0xdc, 0xdc, 0xdc];
        let prog = gen_program(data);
        // Confirm we are still exercising the finding: the generated program
        // is the large-integer product whose value overflows 2^53.
        assert!(prog.contains('*'), "finding program is a product: {}", prog);
        match differential_check(&prog) {
            Ok(()) => {}
            Err(d) => panic!("finding 5c29667cc15d6d93 must not diverge: {:?}", d),
        }
    }

    /// Regression for continuous-fuzz finding `67a52af412f03a7b` (target
    /// `differential_source`). The exact 3-byte minimized input folds into
    /// `(226492416 * 226492416)`, whose exactly representable double value is
    /// `51298814505517056`. XS prints that exact integer while ironhorse emits
    /// the shortest round-tripping `51298814505517060`; the numeric
    /// `results_agree` comparison must recognize that both spellings denote
    /// the identical Number.
    #[test]
    fn finding_67a52af412f03a7b_large_integer_dtoa_agrees() {
        let data = include_bytes!(
            "../../ironhorse-vm/tests/fixtures/finding-67a52af412f03a7b-input.bin"
        );
        let program = gen_program(data);
        assert_eq!(program, "(226492416 * 226492416)");
        match differential_check(&program) {
            Ok(()) => {}
            Err(divergence) => {
                panic!("finding 67a52af412f03a7b must not diverge: {:?}", divergence)
            }
        }
    }

    /// Regression for continuous-fuzz finding `7289e31013d074ec` (target
    /// `differential_source`). The 4-byte input `d8 7f 33 ba` folds into
    /// `((~(~(1560281088 * true))) * ((~(1560281088 * true)) << ((~true) << (true << true))))`,
    /// where `1560281088 = 186 * 2^23` (the generator's "larger integer" atom).
    /// In ToInt32 arithmetic the left factor is `1560281088`, the outer shift is
    /// by `24`, the right factor is `(~1560281088) << 24 = -16777216`, and the
    /// product is `-(93 * 2^48)` = `-26177172834091008`, an exactly-representable
    /// double whose magnitude overflows 2^53. XS's `fx_dtoa` prints that double
    /// verbatim as its 17-digit exact integer, whereas ironhorse — like V8 and
    /// ECMA-262 §6.1.6.1.20's shortest-round-tripping rule — prints
    /// `-26177172834091010`. Both denote the identical double, so the engines
    /// agree on the value and diverge only on decimal spelling; the same class
    /// as `d99d263fcf6ca7a7` / `5c29667cc15d6d93`, already suppressed by the
    /// numeric `results_agree` comparison. The differential check must not read
    /// this as a finding.
    #[test]
    fn finding_7289e31013d074ec_large_integer_dtoa_agrees() {
        // The exact minimized fuzz input (sha256
        // 6abb2fe734124222bc19e12518fa968a59f254edea3c9ed262414cb4637c736f).
        let data: &[u8] = &[0xd8, 0x7f, 0x33, 0xba];
        let prog = gen_program(data);
        // Confirm we are still exercising the finding: the generated program
        // is the large-integer product whose value overflows 2^53.
        assert!(prog.contains('*'), "finding program is a product: {}", prog);
        match differential_check(&prog) {
            Ok(()) => {}
            Err(d) => panic!("finding 7289e31013d074ec must not diverge: {:?}", d),
        }
    }

    /// Regression for continuous-fuzz finding `783be6e6106bad98` (target
    /// `differential_source`). The 6-byte input `00 00 66 69 27 44` folds into
    /// `((((true + 327155712) && (!true)) || ((~570425344) * (true + 327155712)))
    /// + (!(...)))`, which collapses (the `&&` is `false`, so the `||` takes its
    /// right operand; the outer `!(...)` is `false` → `0`) to the single product
    /// `(~570425344) * (327155712 + 1) = -570425345 * 327155713`. Its exact value
    /// `-186617910456745985` overflows 2^53 and rounds to the double
    /// `-186617910456745984`. XS's `fx_dtoa` renders a non-shortest 17-digit form
    /// (`-186617910456745980`) while ironhorse — like V8 and ECMA-262
    /// §6.1.6.1.20's shortest-round-tripping rule — renders `-186617910456746000`.
    /// Both denote the identical double; the same class as `5c29667cc15d6d93` and
    /// `d99d263fcf6ca7a7`, already suppressed by the numeric `results_agree`
    /// comparison. The differential check must not read this as a finding.
    #[test]
    fn finding_783be6e6106bad98_large_integer_dtoa_agrees() {
        // The exact minimized fuzz input (sha256
        // 95c5064e49e6c191f7f9b8be24270555d12b04c226cbc72c01406e024ff39008).
        let data: &[u8] = &[0x00, 0x00, 0x66, 0x69, 0x27, 0x44];
        let prog = gen_program(data);
        // Confirm we are still exercising the finding: the generated program
        // is the large-integer product whose value overflows 2^53.
        assert!(prog.contains('*'), "finding program is a product: {}", prog);
        match differential_check(&prog) {
            Ok(()) => {}
            Err(d) => panic!("finding 783be6e6106bad98 must not diverge: {:?}", d),
        }
    }

    /// Regression for continuous-fuzz finding `a136f9038a1001fb` (target
    /// `differential_regexp_surface`, toolchain `nightly-2026-08-15`). The
    /// 5-byte input folds into a deeply nested `new RegExp(<pattern>, "m")`
    /// whose `.source` completion value is a 1955-byte string — longer than the
    /// oracle's old 1024-byte capture buffer, so the pre-fix oracle truncated
    /// its own reference to 1023 bytes and the harness read the port's correct
    /// full result as a divergence. A distinct input of the same class as
    /// `493390fc03979205` / `3ea435c58b4c588e` (there `.toString()`, here the
    /// `.source` accessor), already covered by that fix (larger buffer + honest
    /// skip on overflow): the exact finding input must check clean, not diverge.
    #[test]
    fn finding_a136f9038a1001fb_regexp_source_agrees() {
        // The exact minimized fuzz input (sha256
        // d3bc62680a221ff9518c4aad6b03787bded65b75091e3b1dd34b1451e7a5835c).
        let data: &[u8] = &[0x2c, 0x2c, 0x2c, 0xd4, 0x88];
        let prog = gen_stage3b_regexp_program(data);
        // Confirm we are still exercising the finding: a RegExp `.source`
        // accessor whose rendered pattern overflows the old 1023-byte buffer.
        assert!(prog.ends_with(".source"), "finding program is a RegExp.source: {}", prog);
        match differential_check_with_symbols(&prog) {
            Ok(()) => {}
            Err(d) => panic!("finding a136f9038a1001fb must not diverge: {:?}", d),
        }
    }

    /// Regression for continuous-fuzz finding `ab889c8f6184c60d` (target
    /// `differential_regexp_surface`, toolchain `nightly-2026-08-15`). The
    /// exact 4-byte input folds into a deeply nested
    /// `new RegExp(<pattern>, "s").source` whose completion value is a
    /// 1216-byte string — longer than the oracle's old 1024-byte capture
    /// buffer, so the pre-fix oracle truncated its own reference to 1023 bytes
    /// and the harness read the port's correct full result as a divergence.
    /// This is a distinct `.source` input of the same class as
    /// `493390fc03979205`, already covered by that finding's causal fix (larger
    /// buffer + honest skip on overflow). The exact input must check clean.
    #[test]
    fn finding_ab889c8f6184c60d_regexp_source_agrees() {
        // The exact minimized fuzz input (sha256
        // e31b5a31b37ce02cba6b665098b0d9844e248e95e89f252910a4ec2660412e07).
        let data =
            include_bytes!("../tests/fixtures/finding-ab889c8f6184c60d.input.bin");
        let prog = gen_stage3b_regexp_program(data);
        // Confirm we are still exercising the finding: a RegExp `.source`
        // accessor whose rendered pattern overflows the old 1023-byte buffer.
        assert!(
            prog.ends_with(".source"),
            "finding program is a RegExp.source: {}",
            prog
        );
        match differential_check_with_symbols(&prog) {
            Ok(()) => {}
            Err(d) => panic!("finding ab889c8f6184c60d must not diverge: {:?}", d),
        }
    }

    /// Regression for continuous-fuzz finding `2276f4edebdcb3bb` (target
    /// `differential_regexp_surface`, toolchain `nightly-2026-08-15`). The
    /// exact 5-byte input folds into a deeply nested `RegExp.source` program
    /// whose 1312-byte completion value overflowed the oracle's old 1024-byte
    /// capture buffer. The oracle returned a truncated prefix and the harness
    /// mistook the port's correct full result for a divergence. The causal
    /// oracle fix from same-class finding `493390fc03979205` (larger buffer
    /// plus an honest skip on overflow) must keep this distinct input clean.
    #[test]
    fn finding_2276f4edebdcb3bb_regexp_source_agrees() {
        // The exact minimized fuzz input (sha256
        // 4f0d6ca037b3a7536fa8e0595f92fd251fbd6aa459d916652f87a3e9f7ad111e).
        let data =
            include_bytes!("../tests/fixtures/finding-2276f4edebdcb3bb.input.bin");
        let program = gen_stage3b_regexp_program(data);
        assert!(
            program.ends_with(".source"),
            "finding program must exercise RegExp.source"
        );
        match differential_check_with_symbols(&program) {
            Ok(()) => {}
            Err(divergence) => {
                panic!("finding 2276f4edebdcb3bb must not diverge: {divergence:?}")
            }
        }
    }

    #[test]
    fn results_agree_on_equal_doubles_spelled_differently() {
        // The finding's two renderings of the same double.
        assert!(results_agree("57632001481506816", "57632001481506820"));
        // A genuine value divergence is still caught.
        assert!(!results_agree("57632001481506816", "57632001481506824"));
        assert!(!results_agree("3", "4"));
        // Non-numeric completions compare byte-for-byte.
        assert!(results_agree("true", "true"));
        assert!(!results_agree("true", "false"));
        assert!(!results_agree("Infinity", "1e999"));
        // `Infinity`/`NaN` are not parsed as numbers (they match as strings).
        assert!(as_ecma_number("Infinity").is_none());
        assert!(as_ecma_number("NaN").is_none());
        assert!(as_ecma_number("").is_none());
    }

    /// Regression for continuous-fuzz finding `493390fc03979205` (target
    /// `differential_regexp_surface`). The 4-byte input folds into a deeply
    /// nested `new RegExp(<pattern>, "s").toString()` whose completion value is
    /// 1099 bytes — longer than the oracle's old 1024-byte capture buffer. The
    /// oracle truncated its own reference to 1023 bytes and the harness read
    /// the port's correct full result as a divergence. With the oracle fix
    /// (larger buffer + honest skip on overflow) the exact finding input must
    /// check clean, not diverge.
    #[test]
    fn finding_493390fc03979205_long_regexp_tostring_agrees() {
        // The exact minimized fuzz input (sha256
        // 450a95b7db1bd744fc94f63a2842714b4e8bf996f97d589fb8aeef172dabbcf7).
        let data: &[u8] = &[0x08, 0x74, 0x74, 0x2a];
        let prog = gen_stage3b_regexp_program(data);
        // Confirm we are still exercising the finding: a RegExp.toString()
        // whose rendered source overflows the old 1023-byte buffer.
        assert!(prog.contains(".toString()"), "finding program is a RegExp.toString(): {}", prog);
        match differential_check_with_symbols(&prog) {
            Ok(()) => {}
            Err(d) => panic!("finding 493390fc03979205 must not diverge: {:?}", d),
        }
    }

    /// Regression for continuous-fuzz finding `3ea435c58b4c588e` (target
    /// `differential_regexp_surface`, toolchain `nightly-2026-08-15`). The
    /// 4-byte input folds into a deeply nested
    /// `new RegExp(<pattern>, "s").toString()` whose completion value is 1128
    /// bytes — longer than the oracle's old 1024-byte capture buffer, so the
    /// pre-fix oracle truncated its own reference to 1023 bytes and the harness
    /// read the port's correct full result as a divergence. A distinct input
    /// of the same class as `493390fc03979205`, already covered by that fix
    /// (larger buffer + honest skip on overflow): the exact finding input must
    /// check clean, not diverge.
    #[test]
    fn finding_3ea435c58b4c588e_regexp_tostring_agrees() {
        // The exact minimized fuzz input (sha256
        // 9df4e2b4ff1278d84c09d3caad69d47b90401dae21573f6d581a7085716e1638).
        let data: &[u8] = &[0x8c, 0x8c, 0x8c, 0xa2];
        let prog = gen_stage3b_regexp_program(data);
        // Confirm we are still exercising the finding: a RegExp.toString()
        // whose rendered source overflows the old 1023-byte buffer.
        assert!(prog.contains(".toString()"), "finding program is a RegExp.toString(): {}", prog);
        match differential_check_with_symbols(&prog) {
            Ok(()) => {}
            Err(d) => panic!("finding 3ea435c58b4c588e must not diverge: {:?}", d),
        }
    }

    #[test]
    fn generated_programs_agree_with_oracle() {
        // Sweep a spread of seeds; every generated subset program must
        // hold bit-exact (result, computron) agreement.
        let mut checked = 0;
        for seed in 0u32..300 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(4 + (seed % 12)) {
                buf.push(data[(k as usize) % 4].wrapping_add(k as u8));
            }
            let prog = gen_program(&buf);
            match differential_check(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
    }

    #[test]
    fn generated_statement_programs_agree_on_results() {
        // The stage-2 generator's var/loop programs must all agree with
        // XS on the completion value (computron parity for this
        // allocating surface awaits the faithful heap).
        let mut checked = 0;
        for seed in 0u32..300 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(6 + (seed % 10)) {
                buf.push(data[(k as usize) % 4].wrapping_add(k as u8 * 7));
            }
            let prog = gen_statement_program(&buf);
            match differential_check_result_only(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-2 differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
    }

    #[test]
    fn generated_stage3_arrays_programs_agree_bit_exact() {
        // The stage-3 arrays generator's literals, indexed get/set, grow, and
        // length get/set programs must ALL agree with XS bit-for-bit
        // (result AND computron): the array item chunk's allocation metering
        // and the length accessor are modeled faithfully, so they ride the
        // full `differential_check`. Sweep a spread of seeds so every branch
        // of the grammar (all six shapes) and the hole/no-hole literal split
        // are exercised.
        let mut checked = 0;
        let mut features = [false; 4]; // literal-only, indexed read, a write, a length op
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..600 {
            // Widen the byte budget so the generator's later `choice`/`next`
            // reads are never starved (a short buffer biases the shape).
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(7))
                        .wrapping_add((seed as u8).wrapping_mul(3)),
                );
            }
            let prog = gen_stage3_arrays_program(&buf);
            distinct.insert(prog.clone());
            if !prog.starts_with("var a=") {
                features[0] = true; // a bare literal
            }
            if prog.contains("]=") {
                features[2] = true; // an element write
            } else if prog.contains('[') && prog.starts_with("var a=") {
                features[1] = true; // an indexed read
            }
            if prog.contains("length") {
                features[3] = true; // a length get/set
            }
            // Arrays need the symbol table linked so `length` routes to the
            // array length semantics.
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3 arrays differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
        // The sweep must be real, varied coverage: a spread of distinct
        // programs, and every top-level grammar feature exercised at least
        // once.
        assert!(distinct.len() > 30, "arrays sweep too uniform: {} distinct", distinct.len());
        for (i, f) in features.iter().enumerate() {
            assert!(*f, "arrays grammar feature {} never generated", i);
        }
    }

    #[test]
    fn generated_stage3_array_methods_agree_bit_exact() {
        // The dense push/pop/indexOf fast paths meter their mxMeterSome
        // annotations and chunk (re)size faithfully, so they ride the full
        // result+computron differential (symbol-linked, since the method
        // names resolve through the program symbol table). Sweep a spread of
        // seeds so every method shape and a range of receiver lengths appear.
        let mut checked = 0;
        let mut methods = [false; 3]; // push, pop, indexOf seen
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..600 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(5))
                        .wrapping_add((seed as u8).wrapping_mul(2)),
                );
            }
            let prog = gen_stage3_array_methods_program(&buf);
            distinct.insert(prog.clone());
            if prog.contains(".push(") {
                methods[0] = true;
            } else if prog.contains(".pop(") {
                methods[1] = true;
            } else if prog.contains(".indexOf(") {
                methods[2] = true;
            }
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3 array-methods differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 30, "methods sweep too uniform: {} distinct", distinct.len());
        for (i, m) in methods.iter().enumerate() {
            assert!(*m, "array method {} never generated", i);
        }
    }

    #[test]
    fn generated_stage3_array_iterators_agree_bit_exact() {
        // The array iterator objects (values/keys/entries + next over the
        // reused result object) meter their fxNewIteratorInstance creation and
        // per-next yield/element-read faithfully, so they ride the full
        // result+computron differential. Sweep a spread of seeds so every
        // iterator kind, a range of lengths, and both past-the-end and
        // in-range exhaustion appear.
        let mut checked = 0;
        let mut kinds = [false; 3]; // values, keys, entries seen
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..600 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(11))
                        .wrapping_add((seed as u8).wrapping_mul(4)),
                );
            }
            let prog = gen_stage3_array_iterators_program(&buf);
            distinct.insert(prog.clone());
            if prog.contains(".values(") {
                kinds[0] = true;
            } else if prog.contains(".keys(") {
                kinds[1] = true;
            } else if prog.contains(".entries(") {
                kinds[2] = true;
            }
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3 array-iterators differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 30, "iterators sweep too uniform: {} distinct", distinct.len());
        for (i, k) in kinds.iter().enumerate() {
            assert!(*k, "iterator kind {} never generated", i);
        }
    }

    #[test]
    fn generated_stage3_for_of_programs_agree_bit_exact() {
        // for-of over an array literal drives fxGetIterator + the values
        // iterator's per-element next() protocol, all metered faithfully, so
        // it rides the full result+computron differential. Sweep a spread of
        // seeds over the three loop shapes and a range of array lengths
        // (including the empty array).
        let mut checked = 0;
        let mut shapes = [false; 3];
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..600 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(13))
                        .wrapping_add((seed as u8).wrapping_mul(6)),
                );
            }
            let prog = gen_stage3_for_of_program(&buf);
            distinct.insert(prog.clone());
            if prog.contains("n=n+1") {
                shapes[1] = true;
            } else if prog.contains("s=\"\"") {
                shapes[2] = true;
            } else {
                shapes[0] = true;
            }
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3 for-of differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 20, "for-of sweep too uniform: {} distinct", distinct.len());
        for (i, s) in shapes.iter().enumerate() {
            assert!(*s, "for-of shape {} never generated", i);
        }
    }

    #[test]
    fn generated_stage3_string_for_of_programs_agree_bit_exact() {
        // for-of over a string drives fxGetIterator + the string iterator's
        // per-code-point next() (a fresh one-char result string per step), all
        // metered faithfully over an ASCII (single-byte BMP) alphabet, so it
        // rides the full result+computron differential.
        let mut checked = 0;
        let mut shapes = [false; 3];
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..600 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(13))
                        .wrapping_add((seed as u8).wrapping_mul(6)),
                );
            }
            let prog = gen_stage3_string_for_of_program(&buf);
            distinct.insert(prog.clone());
            if prog.contains("n=n+1") {
                shapes[1] = true;
            } else if prog.contains("r=c+r") {
                shapes[2] = true;
            } else {
                shapes[0] = true;
            }
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3 string for-of differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 20, "string for-of sweep too uniform: {} distinct", distinct.len());
        for (i, s) in shapes.iter().enumerate() {
            assert!(*s, "string for-of shape {} never generated", i);
        }
    }

    #[test]
    fn generated_stage3_text_math_programs_agree_bit_exact() {
        // The stage-3 text-math-json surface (Math statics, String.prototype,
        // Number predicates, parseInt/parseFloat/isNaN, JSON.stringify of a
        // primitive) is bit-exact (result AND computron); sweep a spread of
        // seeds across all five shapes and assert zero divergence.
        let mut checked = 0;
        // Coverage flags for the built-in families the arm must reach.
        let (mut math, mut string, mut number, mut json) = (false, false, false, false);
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..800 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(11))
                        .wrapping_add((seed as u8).wrapping_mul(7)),
                );
            }
            let prog = gen_stage3_text_math_program(&buf);
            distinct.insert(prog.clone());
            math |= prog.contains("Math.");
            string |= prog.contains(".toUpperCase")
                || prog.contains(".toLowerCase")
                || prog.contains(".charCodeAt")
                || prog.contains(".slice")
                || prog.contains(".concat")
                || prog.contains(".includes")
                || prog.contains(".length");
            number |= prog.contains("Number.") || prog.contains("parseInt") || prog.contains("parseFloat") || prog.contains("isNaN");
            json |= prog.contains("JSON.");
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3 text-math-json differential divergence on {:?}: {:?}", prog, d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 40, "text-math-json sweep too uniform: {} distinct", distinct.len());
        assert!(math && string && number && json, "families reached: math={} string={} number={} json={}", math, string, number, json);
    }

    #[test]
    fn generated_stage3b_json_structured_programs_agree_bit_exact() {
        // The stage-3b json-metering surface — structured JSON.stringify over
        // objects and arrays built recursively from primitives — is bit-exact
        // (serialized value AND computron). Sweep a spread of seeds over the
        // recursive generator and assert zero divergence, reaching both the
        // object and array node shapes and depth beyond a single level.
        let mut checked = 0;
        let (mut object, mut array, mut nested) = (false, false, false);
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..800 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(24 + (seed % 40)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(11))
                        .wrapping_add((seed as u8).wrapping_mul(7)),
                );
            }
            let prog = gen_json_structured_program(&buf);
            distinct.insert(prog.clone());
            object |= prog.contains('{');
            array |= prog.contains('[');
            nested |= prog.contains("{{")
                || prog.contains("[[")
                || prog.contains("[{")
                || prog.contains("{") && prog.contains("[");
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3b json-metering differential divergence on {:?}: {:?}", prog, d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 40, "json-structured sweep too uniform: {} distinct", distinct.len());
        assert!(object && array && nested, "shapes reached: object={} array={} nested={}", object, array, nested);
    }

    #[test]
    fn generated_stage3b_json_parse_programs_agree_bit_exact() {
        // The stage-3b json-metering parse surface — JSON.parse over well-formed
        // JSON built recursively from primitives, arrays, and objects — is
        // bit-exact (result AND computron). Sweep a spread of seeds, reaching
        // primitive, array, and object shapes and depth beyond one level.
        let mut checked = 0;
        let (mut prim, mut array, mut object) = (false, false, false);
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..800 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(24 + (seed % 40)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(11))
                        .wrapping_add((seed as u8).wrapping_mul(7)),
                );
            }
            let prog = gen_json_parse_program(&buf);
            distinct.insert(prog.clone());
            object |= prog.contains('{');
            array |= prog.contains('[');
            prim |= !prog.contains('{') && !prog.contains('[');
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3b json-parse differential divergence on {:?}: {:?}", prog, d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 40, "json-parse sweep too uniform: {} distinct", distinct.len());
        assert!(prim && array && object, "shapes reached: prim={} array={} object={}", prim, array, object);
    }

    #[test]
    fn generated_stage3b_promise_programs_agree_bit_exact() {
        // The stage-3b promises surface — a fulfilled resolution chain over
        // Promise/`resolve`/`then`/`catch` driven to the pump-loop drain — is
        // bit-exact (result AND computron), INCLUDING the reactions run at the
        // drain. Sweep a spread of seeds, reaching the resolve-static,
        // executor-resolve, and pending sources and chains of length 0..3.
        let mut checked = 0;
        let (mut resolved, mut executor, mut pending, mut chained) = (false, false, false, false);
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..800 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(24 + (seed % 40)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(11))
                        .wrapping_add((seed as u8).wrapping_mul(7)),
                );
            }
            let prog = gen_stage3b_promise_program(&buf);
            distinct.insert(prog.clone());
            resolved |= prog.contains("Promise.resolve");
            executor |= prog.contains("function(res)") || prog.contains("function(resolve,reject)");
            pending |= prog.contains("function(){}");
            chained |= prog.contains(").then") || prog.contains(").catch");
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3b promises differential divergence on {:?}: {:?}", prog, d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 40, "promise sweep too uniform: {} distinct", distinct.len());
        assert!(
            resolved && executor && pending && chained,
            "shapes reached: resolved={} executor={} pending={} chained={}",
            resolved, executor, pending, chained
        );
    }

    #[test]
    fn generated_stage3b_regexp_surface_programs_agree_bit_exact() {
        // The stage-3b xsre-integration surface (child 9/9): a whole-program
        // `new RegExp(pat, flags).exec/test/…(subj)` over the covered grammar is
        // bit-exact (result AND computron) end-to-end against the pin — the
        // construction metering, the exec/test result shaping, and the accessor
        // getters. Sweep a spread of seeds, reaching every observed operation.
        let mut checked = 0;
        let mut skipped = 0;
        let (mut execd, mut tested, mut sourced, mut flagged, mut stringed) =
            (false, false, false, false, false);
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..1200 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(20 + (seed % 48)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(13))
                        .wrapping_add((seed as u8).wrapping_mul(5)),
                );
            }
            let prog = gen_stage3b_regexp_program(&buf);
            distinct.insert(prog.clone());
            execd |= prog.contains(".exec(");
            tested |= prog.contains(".test(");
            sourced |= prog.contains(".source");
            flagged |= prog.contains(".flags");
            stringed |= prog.contains(".toString()");
            // The differential check skips an out-of-subset pattern honestly
            // (ironhorse halts `Unsupported`, `differential_check` returns Ok
            // without comparing); count coverage by the checks that ran.
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3b regexp-surface differential divergence on {:?}: {:?}", prog, d),
            }
            if prog.contains("Unsupported") {
                skipped += 1;
            }
        }
        let _ = skipped;
        assert!(checked > 0);
        assert!(distinct.len() > 60, "regexp sweep too uniform: {} distinct", distinct.len());
        assert!(
            execd && tested && sourced && flagged && stringed,
            "ops reached: exec={} test={} source={} flags={} toString={}",
            execd, tested, sourced, flagged, stringed
        );
    }

    #[test]
    fn generated_stage3_spread_programs_agree_bit_exact() {
        // Single-segment array spread desugars to the for-of iterator loop
        // appending each element; raw-exact against the pin. Sweep a spread of
        // seeds over the three observation shapes and a range of lengths and
        // lead/trail combinations.
        let mut checked = 0;
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..600 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(17))
                        .wrapping_add((seed as u8).wrapping_mul(9)),
                );
            }
            let prog = gen_stage3_spread_program(&buf);
            distinct.insert(prog.clone());
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3 spread differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 20, "spread sweep too uniform: {} distinct", distinct.len());
    }

    #[test]
    fn generated_stage3_reentrant_programs_agree_bit_exact() {
        // forEach drives a user callback per element through run_callback; the
        // callback body's opcodes are metered by the nested dispatch and the
        // per-element fxCallThisItem overhead is a calibrated constant, so the
        // whole thing is bit-exact (result AND computron). Sweep a spread of
        // seeds over the three callback shapes and a range of lengths.
        let mut checked = 0;
        let mut shapes = [false; 3];
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..600 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(23))
                        .wrapping_add((seed as u8).wrapping_mul(2)),
                );
            }
            let prog = gen_stage3_reentrant_program(&buf);
            distinct.insert(prog.clone());
            if prog.contains("s=s+i") {
                shapes[1] = true;
            } else if prog.contains("n=n+1") {
                shapes[2] = true;
            } else {
                shapes[0] = true;
            }
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3 re-entrant differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 20, "re-entrant sweep too uniform: {} distinct", distinct.len());
        for (i, s) in shapes.iter().enumerate() {
            assert!(*s, "re-entrant shape {} never generated", i);
        }
    }

    #[test]
    fn generated_stage3_collections_programs_agree_bit_exact() {
        // Map/Set forEach, entries/keys/values iterators, for-of, and spread —
        // the stage-3b keyed-collection iteration surface, bit-exact (result
        // AND computron). Sweep a spread of seeds over Map vs Set, a range of
        // entry counts (including empty), and every observation shape.
        let mut checked = 0;
        let mut kinds = [false; 2]; // Set, Map
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..800 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(29))
                        .wrapping_add((seed as u8).wrapping_mul(4)),
                );
            }
            let prog = gen_stage3_collections_program(&buf);
            distinct.insert(prog.clone());
            if prog.contains("new Set") {
                kinds[0] = true;
            } else {
                kinds[1] = true;
            }
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3 collections differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 20, "collections sweep too uniform: {} distinct", distinct.len());
        for (i, k) in kinds.iter().enumerate() {
            assert!(*k, "collections kind {} never generated", i);
        }
    }

    #[test]
    fn generated_stage3_bigint_programs_agree_bit_exact() {
        // The stage-3b BigInt grammar — literals, `+`/`-`/`*` (same-type),
        // unary minus, strict/loose equality (including BigInt-vs-Number),
        // relational order, typeof, and decimal rendering — bit-exact (result
        // AND computron) vs XS. Sweep a spread of seeds so every arm and a
        // range of operand magnitudes (single- and multi-limb) are reached.
        let mut checked = 0;
        let mut saw_typeof = false;
        let mut saw_neg = false;
        let mut saw_mul = false;
        let mut saw_cmp = false;
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..800 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(29))
                        .wrapping_add((seed as u8).wrapping_mul(4)),
                );
            }
            let prog = gen_stage3_bigint_program(&buf);
            distinct.insert(prog.clone());
            saw_typeof |= prog.contains("typeof");
            saw_neg |= prog.contains("(-");
            saw_mul |= prog.contains('*');
            saw_cmp |= prog.contains("===") || prog.contains('<') || prog.contains('>');
            match differential_check(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3b bigint differential divergence on {:?}: {:?}", prog, d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 40, "bigint sweep too uniform: {} distinct", distinct.len());
        assert!(saw_typeof, "typeof arm never generated");
        assert!(saw_neg, "negation never generated");
        assert!(saw_mul, "multiplication never generated");
        assert!(saw_cmp, "comparison never generated");
    }

    #[test]
    fn generated_stage3b_binary_programs_agree_bit_exact() {
        // The stage-3b binary-data grammar — `new ArrayBuffer(n)` over a
        // spread of byte lengths (crossing the 8-byte chunk-alignment
        // boundary) and the `byteLength` accessor — bit-exact (result AND
        // computron) vs XS. Rides the symbol-linking differential check
        // (the `ArrayBuffer` global and `byteLength` are program symbols).
        let mut checked = 0;
        let mut saw_buffer = false;
        let mut saw_typed = false;
        let mut saw_element = false;
        let mut saw_loop = false;
        let mut saw_dataview = false;
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..1200 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(29))
                        .wrapping_add((seed as u8).wrapping_mul(4)),
                );
            }
            let prog = gen_stage3b_binary_program(&buf);
            distinct.insert(prog.clone());
            saw_buffer |= prog.contains("new ArrayBuffer");
            saw_typed |= prog.contains("Array(");
            saw_element |= prog.contains("] =");
            saw_loop |= prog.contains("while");
            saw_dataview |= prog.contains("DataView");
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3b binary differential divergence on {:?}: {:?}", prog, d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 40, "binary sweep too uniform: {} distinct", distinct.len());
        assert!(saw_buffer, "ArrayBuffer arm never generated");
        assert!(saw_typed, "TypedArray arm never generated");
        assert!(saw_element, "element write/read arm never generated");
        assert!(saw_loop, "fill-loop arm never generated");
        assert!(saw_dataview, "DataView arm never generated");
    }

    #[test]
    fn generated_stage3b_fundamentals_followup_programs_agree_bit_exact() {
        // The stage-3b fundamentals-followup grammar — a function's
        // `.length`/`.name`, `Function.prototype.bind` (create + call),
        // `apply` with a dense array, `Symbol.prototype.toString`/
        // `String(symbol)`/`Symbol.for`/`keyFor`, and `AggregateError` — every
        // generated program bit-exact (result AND computron) vs XS. Rides
        // the symbol-linking differential check (the built-ins + property
        // names are program symbols).
        let mut checked = 0;
        let mut saw_length = false;
        let mut saw_name = false;
        let mut saw_bind = false;
        let mut saw_apply = false;
        let mut saw_symbol = false;
        let mut saw_aggregate = false;
        let mut saw_callback = false;
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..1200 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(29))
                        .wrapping_add((seed as u8).wrapping_mul(4)),
                );
            }
            let prog = gen_stage3b_fundamentals_followup_program(&buf);
            distinct.insert(prog.clone());
            saw_length |= prog.contains(".length");
            saw_name |= prog.contains(".name");
            saw_bind |= prog.contains(".bind(");
            saw_apply |= prog.contains(".apply(");
            saw_symbol |= prog.contains("Symbol");
            saw_aggregate |= prog.contains("AggregateError");
            saw_callback |= prog.contains(".map(cf.bind(")
                || prog.contains(".forEach(cf.bind(")
                || prog.contains(".filter(cf.bind(")
                || prog.contains(".reduce(cf.bind(");
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!(
                    "stage-3b fundamentals-followup differential divergence on {:?}: {:?}",
                    prog, d
                ),
            }
        }
        assert!(checked > 0);
        assert!(
            distinct.len() > 40,
            "followup sweep too uniform: {} distinct",
            distinct.len()
        );
        assert!(saw_length, ".length arm never generated");
        assert!(saw_name, ".name arm never generated");
        assert!(saw_bind, "bind arm never generated");
        assert!(saw_apply, "apply arm never generated");
        assert!(saw_symbol, "Symbol arm never generated");
        assert!(saw_aggregate, "AggregateError arm never generated");
        assert!(saw_callback, "bound-callback arm never generated");
    }

    #[test]
    fn generated_stage3b_object_statics_programs_agree_bit_exact() {
        // The object-statics + intern-table arm: hasOwnProperty / Object.keys /
        // getOwnPropertyDescriptor over random small ordinary objects, present
        // and absent keys (novel + pre-interned default), all bit-exact (result
        // AND computron) under the full symbol-linking differential check.
        let mut checked = 0;
        let mut saw_has = false;
        let mut saw_keys = false;
        let mut saw_gopd = false;
        let mut saw_absent = false;
        let mut saw_computed = false;
        let mut saw_defprop = false;
        let mut saw_in = false;
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..1200 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(23))
                        .wrapping_add((seed as u8).wrapping_mul(3)),
                );
            }
            let prog = gen_stage3b_object_statics_program(&buf);
            distinct.insert(prog.clone());
            saw_has |= prog.contains(".hasOwnProperty(");
            saw_keys |= prog.contains("Object.keys(");
            saw_gopd |= prog.contains("Object.getOwnPropertyDescriptor(");
            saw_absent |= prog.contains("zzz") || prog.contains("missing");
            saw_computed |= prog.contains("var k=");
            saw_defprop |= prog.contains("Object.defineProperty(");
            saw_in |= prog.contains(" in o");
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!(
                    "stage-3b object-statics differential divergence on {:?}: {:?}",
                    prog, d
                ),
            }
        }
        assert!(checked > 0);
        assert!(
            distinct.len() > 30,
            "object-statics sweep too uniform: {} distinct",
            distinct.len()
        );
        assert!(saw_has, "hasOwnProperty arm never generated");
        assert!(saw_keys, "Object.keys arm never generated");
        assert!(saw_gopd, "getOwnPropertyDescriptor arm never generated");
        assert!(saw_absent, "absent-key arm never generated");
        assert!(saw_computed, "computed member-access arm never generated");
        assert!(saw_defprop, "defineProperty arm never generated");
        assert!(saw_in, "`in` operator arm never generated");
    }

    #[test]
    fn generated_stage3_for_in_programs_agree_bit_exact() {
        // for-in over an object literal or array drives the enumerator's key
        // collection + per-key yield, computron-exact. Sweep a spread of seeds
        // over object/array targets, a range of key counts (including empty),
        // and both loop bodies.
        let mut checked = 0;
        let mut kinds = [false; 2]; // object target, array target
        let mut distinct = std::collections::BTreeSet::new();
        for seed in 0u32..600 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(16 + (seed % 24)) {
                buf.push(
                    data[(k as usize) % 4]
                        .wrapping_add((k as u8).wrapping_mul(19))
                        .wrapping_add((seed as u8).wrapping_mul(2)),
                );
            }
            let prog = gen_stage3_for_in_program(&buf);
            distinct.insert(prog.clone());
            if prog.contains("in {") {
                kinds[0] = true;
            } else if prog.contains("in [") {
                kinds[1] = true;
            }
            match differential_check_with_symbols(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-3 for-in differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
        assert!(distinct.len() > 20, "for-in sweep too uniform: {} distinct", distinct.len());
        for (i, k) in kinds.iter().enumerate() {
            assert!(*k, "for-in target {} never generated", i);
        }
    }

    #[test]
    fn generated_stage2b_programs_agree_bit_exact() {
        // The stage-2b generator's object / call / closure / exception
        // programs must ALL agree with XS bit-for-bit (result AND
        // computron) — the object model, call frames, closure cells, and
        // the exception jump-chain are metered faithfully, so unlike the
        // stage-2 result-only surface these ride the full
        // `differential_check`. Sweep a spread of seeds so every branch of
        // the grammar (both object shapes, all three call shapes, both
        // closure shapes, all three exception shapes) is exercised.
        let mut checked = 0;
        let mut kinds = [0usize; 4];
        for seed in 0u32..400 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(6 + (seed % 14)) {
                buf.push(data[(k as usize) % 4].wrapping_add(k as u8 * 5));
            }
            kinds[(buf[0] % 4) as usize] += 1;
            let prog = gen_stage2b_program(&buf);
            match differential_check(&prog) {
                Ok(()) => checked += 1,
                Err(d) => panic!("stage-2b differential divergence: {:?}", d),
            }
        }
        assert!(checked > 0);
        // Every grammar family must have been generated at least once, so
        // the sweep is real coverage, not one branch 400 times.
        for (i, c) in kinds.iter().enumerate() {
            assert!(*c > 0, "grammar family {} never generated", i);
        }
    }

    #[test]
    fn decoder_never_panics_on_arbitrary_bytes() {
        for seed in 0u32..2000 {
            let mut s = seed.wrapping_mul(2654435761);
            let n = (s % 40) as usize;
            let mut bytes = Vec::with_capacity(n);
            for _ in 0..n {
                s = s.wrapping_mul(1103515245).wrapping_add(12345);
                bytes.push((s >> 16) as u8);
            }
            let _ = decoder_is_panic_free(&bytes);
        }
        // Truncated operand: NUMBER opcode (0x8f) needs 8 bytes, give 2.
        let _ = decoder_is_panic_free(&[0x8f, 0x00, 0x00]);
        // Backward branch off the front.
        let _ = decoder_is_panic_free(&[0x16, 0x80]);
        // Regression (stage-4a decoder hang, seed 1750): a `BRANCH_STATUS_1`
        // (0x25) with offset 0xfe (-2) targets its own pc — a zero-progress
        // self-loop. The generators child (b41446ad7) gave opcode 37 a real
        // backward-branch handler; before that it was an unimplemented byte
        // that halted. With no metering host armed, this spun `run_program`
        // forever and wedged `cargo test --workspace`. The bounded decoder
        // entry now aborts it with `Halt::StepLimit`. Full 14-byte seed
        // string plus the minimal 2-byte core.
        let _ = decoder_is_panic_free(&[
            0x25, 0xfe, 0x86, 0x1c, 0x28, 0xee, 0x59, 0x08, 0xa6, 0xf7, 0xec, 0xc0, 0x0d, 0x17,
        ]);
        let _ = decoder_is_panic_free(&[0x25, 0xfe]);
    }

    /// Wedge-proofing lock: the self-targeting backward branch that caused the
    /// stage-4a decoder hang must abort with a bounded `Halt::StepLimit` — not
    /// spin — and every fixed malformed case above must return promptly. A
    /// future non-terminating decode arm fails this in milliseconds (the
    /// `StepLimit` assertion) instead of hanging the whole workspace bar.
    #[test]
    fn decoder_hang_is_bounded_not_infinite() {
        // The minimal reproducer: `BRANCH_STATUS_1` (0x25), offset -2 → pc 0.
        let core = run_program_bounded(&[0x25, 0xfe], DECODER_STEP_LIMIT);
        assert_eq!(
            core.halt,
            ironhorse_vm::Halt::StepLimit(DECODER_STEP_LIMIT),
            "self-targeting backward branch must hit the step ceiling, not complete or hang"
        );
        // The full seed-1750 string aborts the same bounded way.
        let full = run_program_bounded(
            &[
                0x25, 0xfe, 0x86, 0x1c, 0x28, 0xee, 0x59, 0x08, 0xa6, 0xf7, 0xec, 0xc0, 0x0d, 0x17,
            ],
            DECODER_STEP_LIMIT,
        );
        assert!(
            matches!(full.halt, ironhorse_vm::Halt::StepLimit(_)),
            "seed-1750 decode must abort under the step ceiling, got {:?}",
            full.halt
        );
    }

    #[test]
    fn parser_is_total_over_generated_and_arbitrary_bytes() {
        // The armed parser fuzz target's invariant, exercised as a bounded
        // smoke run: neither a structure-aware generated program nor raw
        // arbitrary bytes may drive `ironhorse_compile::Parser` to a panic —
        // only a `Result` (accept or structured reject).
        let mut accepted = 0usize;
        for seed in 0u32..512 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(4 + (seed % 24)) {
                buf.push(data[(k as usize) % 4].wrapping_add(k as u8));
            }
            // Generated programs.
            let prog = gen_compile_program(&buf);
            if parse_is_panic_free(&prog) {
                accepted += 1;
            }
            // Arbitrary bytes as UTF-8 (lossy) — the parser must not panic
            // on ill-formed source either.
            let raw = String::from_utf8_lossy(&buf);
            let _ = parse_is_panic_free(&raw);
        }
        assert!(accepted > 0, "some generated programs should parse");
    }

    #[test]
    fn compile_differential_smoke() {
        // The armed compile-differential target as a bounded smoke run:
        // over a spread of generated programs, every outcome is one of the
        // NAMED classifications and a genuine `ByteDivergence` /
        // `OracleRejected` (ironhorse accepting what XS rejects) is a finding.
        // `IronhorseRejected` (a coder fold) and `OracleUnavailable` (an oracle
        // startup failure) are expected, non-fatal outcomes here — the
        // point of this smoke is that the harness never panics and never
        // surfaces a false byte divergence, not that the fold is closed.
        let mut identical = 0usize;
        let mut findings: Vec<(String, CompileFuzzOutcome)> = Vec::new();
        for seed in 0u32..256 {
            let data = seed.to_le_bytes();
            let mut buf = Vec::new();
            for k in 0..(4 + (seed % 16)) {
                buf.push(data[(k as usize) % 4].wrapping_add(k as u8));
            }
            let prog = gen_compile_program(&buf);
            let outcome = compile_differential_check(&prog);
            match outcome {
                CompileFuzzOutcome::Identical => identical += 1,
                CompileFuzzOutcome::ByteDivergence { .. } | CompileFuzzOutcome::OracleRejected => {
                    findings.push((prog, outcome))
                }
                // Expected non-fatal outcomes in a bounded smoke.
                CompileFuzzOutcome::BothReject
                | CompileFuzzOutcome::IronhorseRejected { .. }
                | CompileFuzzOutcome::OracleUnavailable => {}
            }
        }
        assert!(
            findings.is_empty(),
            "compile-differential findings (byte divergence or ironhorse-only accept): {:#?}",
            findings
        );
        assert!(identical > 0, "some generated programs should compile byte-identically");
    }
}

#[cfg(test)]
mod hostile_suspend_tests {
    //! The YIELD twin of the AWAIT stack-underflow guard (both landed
    //! after the fuzz lane's first CI trophy; the AWAIT lock lives in
    //! ironhorse-vm's unit tests, driven by seven raw bytes). Raw
    //! top-level bytecode cannot reach a generator RESUME — the
    //! `gen_run_stack` base is recorded only inside the `.next()`
    //! driver — so this reproducer compiles a real generator program
    //! and then rewrites the resumed body itself: every byte between
    //! `START_GENERATOR` and the body's `YIELD` becomes a POP (one
    //! byte each, so every offset and the trailing branch survive).
    //! The resumed frame's own stack starts empty, so those pops
    //! drain the DRIVER's slots below the recorded run base — exactly
    //! the shape hostile bytecode produces — and the YIELD guard must
    //! refuse it by name instead of letting `split_off` panic.

    #[test]
    fn hostile_yield_below_run_base_fails_closed() {
        let (bytecode, symbols) =
            ironhorse_compile::compile_atoms("function* g() { yield; } var it = g(); it.next();")
                .expect("generator fixture compiles");
        // Sanity: the untampered program runs to completion.
        let clean = ironhorse_vm::run_program_with_symbols(&bytecode, &symbols);
        assert!(clean.completed, "clean generator fixture: {:?}", clean.halt);

        const START_GENERATOR: u8 = 195; // XS_CODE_START_GENERATOR
        const POP: u8 = 146; //             XS_CODE_POP (1 byte)
        const YIELD: u8 = 235; //           XS_CODE_YIELD

        // Walk instruction boundaries (the vm's own decode, so a
        // literal byte inside an operand cannot be mistaken for an
        // opcode) to find the generator body: START_GENERATOR, then
        // the first YIELD after it.
        let mut start = None;
        let mut yield_at = None;
        let mut pc = 0usize;
        while pc < bytecode.len() {
            match bytecode[pc] {
                START_GENERATOR if start.is_none() => start = Some(pc),
                YIELD if start.is_some() && yield_at.is_none() => yield_at = Some(pc),
                _ => {}
            }
            pc += ironhorse_vm::instruction_len(&bytecode, pc)
                .expect("compiled fixture decodes")
                .max(1);
        }
        let (start, yield_at) = (
            start.expect("fixture has START_GENERATOR"),
            yield_at.expect("fixture has YIELD after it"),
        );

        let mut patched = bytecode.clone();
        for b in &mut patched[start + 1..yield_at] {
            *b = POP;
        }

        // The patch only replaces instructions with POPs, so it
        // cannot introduce a dispatch cycle; the unbounded symbols
        // runner (the clean run's entry) is safe.
        let out = ironhorse_vm::run_program_with_symbols(&patched, &symbols);
        assert_eq!(
            out.halt,
            ironhorse_vm::Halt::Unsupported("yield:stack-underflow"),
            "the YIELD guard refuses a frame drained below its run base"
        );
    }
}
