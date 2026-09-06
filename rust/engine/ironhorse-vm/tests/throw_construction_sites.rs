//! Source-level lock on where an uncaught throw may be manufactured
//! (architecture review F004 / F005).
//!
//! `Halt::Throw` is the host's view of a JavaScript throw that escaped
//! every guest handler. It is legitimate at exactly three kinds of site:
//!
//! 1. `raise_js`, the one engine raise path, after `unwind_to_jump` found
//!    the jump chain empty;
//! 2. the dispatch loop's own inline unwinds — the `THROW` and `RETHROW`
//!    opcodes and a rejected `await` resume — which do the same unwind
//!    with the value already in hand;
//! 3. the two post-run harness shims in `run`, which model the oracle
//!    shim's `String(result)` failing on a `Symbol` or a null-prototype
//!    object completion. No guest value exists there, so they are
//!    `Halt::synthetic_throw`, the harness-only constructor.
//!
//! Every other `Halt::Throw(...)` an engine helper used to build inline
//! ("TypeError: defineProperty target", twenty-nine of them at the peak)
//! never consulted the jump chain, so guest `try`/`catch` could not catch
//! it, and never set `self.exception`, so a promise executor that hit one
//! rejected with `undefined`. Carrying the thrown `Slot` in the variant
//! makes such a site a compile error; this test keeps the allowed set from
//! growing back, in the shape `gc_visitation_registry.rs` uses.

const SRC: &str = include_str!("../src/interp.rs");

/// The body (including braces) of the function that starts at the first
/// occurrence of `marker`.
fn fn_body(marker: &str) -> &'static str {
    let i = SRC
        .find(marker)
        .unwrap_or_else(|| panic!("marker not found: {marker}"));
    let j = i + SRC[i..].find('{').expect("fn body opens");
    let bytes = SRC.as_bytes();
    let mut depth = 0usize;
    let mut k = j;
    loop {
        match bytes[k] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return &SRC[j..=k];
                }
            }
            _ => {}
        }
        k += 1;
    }
}

fn strip_comments(s: &str) -> String {
    s.lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

fn line_of(hay: &str, at: usize) -> usize {
    hay[..at].matches('\n').count() + 1
}

/// Offsets of every `Halt::Throw {` that is a CONSTRUCTION rather than a
/// pattern. Every pattern in the engine binds a subset of the fields and
/// carries a `..` rest (`Halt::Throw { value, .. }`, `Halt::Throw { .. }`);
/// a construction must supply both fields and so never does.
fn throw_constructions(hay: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut start = 0;
    while let Some(p) = hay[start..].find("Halt::Throw {") {
        let at = start + p;
        let open = at + "Halt::Throw ".len();
        let bytes = hay.as_bytes();
        let mut depth = 0usize;
        let mut k = open;
        let close = loop {
            match bytes[k] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        break k;
                    }
                }
                _ => {}
            }
            k += 1;
        };
        if !hay[open..=close].contains("..") {
            out.push(at);
        }
        start = close;
    }
    out
}

fn count(hay: &str, needle: &str) -> usize {
    hay.matches(needle).count()
}

#[test]
fn halt_throw_carries_the_thrown_value() {
    let halt = fn_body("pub enum Halt {");
    assert!(
        halt.contains("Throw {") && halt.contains("value: Slot") && halt.contains("rendered: String"),
        "Halt::Throw must carry the thrown Slot alongside its rendering; a bare \
         `Throw(String)` is what let 29 inline sites bypass raise_js"
    );
}

#[test]
fn halt_throw_is_constructed_only_where_the_jump_chain_was_unwound() {
    let src = strip_comments(SRC);
    let engine = match src.find("#[cfg(test)]") {
        Some(i) => &src[..i],
        None => &src[..],
    };
    // The allowed sites, with exact counts so the set cannot grow silently.
    let allowed: &[(&str, usize)] = &[
        ("fn raise_js(", 1),
        // THROW, RETHROW, rejected-await resume.
        ("fn dispatch_at_inner(", 3),
        // `Halt::synthetic_throw`'s own body.
        ("pub fn synthetic_throw(", 1),
    ];
    let mut allowed_total = 0;
    for (marker, expected) in allowed {
        let body = strip_comments(fn_body(marker));
        let n = throw_constructions(&body).len();
        assert_eq!(
            n, *expected,
            "{marker} constructs Halt::Throw {n} times, expected {expected}"
        );
        allowed_total += n;
    }
    let all = throw_constructions(engine);
    let stray: Vec<String> = if all.len() > allowed_total {
        all.iter()
            .map(|&at| format!("  interp.rs:{}", line_of(engine, at)))
            .collect()
    } else {
        Vec::new()
    };
    assert_eq!(
        all.len(),
        allowed_total,
        "Halt::Throw constructed outside raise_js / the loop's inline unwinds; \
         an engine error must be a real error object routed through raise_js \
         (catchable_type_error_msg or a sibling). All sites:\n{}",
        stray.join("\n")
    );
    // The harness-only constructor: the two post-run shims in `run`, nowhere
    // else in engine code.
    let run_body = strip_comments(fn_body("    pub fn run(&mut self, code: &[u8]) -> RunOutcome {"));
    assert_eq!(
        count(&run_body, "Halt::synthetic_throw("),
        2,
        "run() models exactly two post-run harness conversions"
    );
    let synthetic_body = strip_comments(fn_body("pub fn synthetic_throw("));
    assert_eq!(
        count(engine, "Halt::synthetic_throw(") - count(&synthetic_body, "Halt::synthetic_throw("),
        2,
        "Halt::synthetic_throw is for the harness and run()'s post-run shims only; \
         a guest-reachable error needs a real error object"
    );
    // And no native-try boundary reads the thrown value back out of the
    // register: it takes the value from the `Halt::Throw` it matched. The
    // register's remaining readers are the opcodes XS's `mxException` serves
    // (`EXCEPTION`, `RETHROW`, `USED`) and `render_uncaught`'s save/restore.
    let allowed_reads = [
        "let saved_exception = self.exception;",
        "let ex = self.exception;",
        "let v = self.exception;",
        "let current = self.exception;",
    ];
    let stray: Vec<String> = engine
        .lines()
        .enumerate()
        .filter(|(_, l)| l.contains("= self.exception;"))
        .filter(|(_, l)| !allowed_reads.iter().any(|a| l.contains(a)))
        .map(|(i, l)| format!("  interp.rs:{}: {}", i + 1, l.trim()))
        .collect();
    assert!(
        stray.is_empty(),
        "a thrown value must travel in `Halt::Throw {{ value, .. }}`, not be \
         recovered from `self.exception` (which an inline throw never set):\n{}",
        stray.join("\n")
    );
}
