//! Source-level lock on how the bytecode dispatch loop consumes a control
//! transfer (architecture review F001 / F006).
//!
//! `raise_js` unwinds the jump chain and hands back the handler's resume
//! pc. Whether THIS dispatch loop may resume there depends on whose frame
//! the handler lives in: a handler below the loop's `return_depth`
//! belongs to an enclosing Rust-level dispatch (the caller of a native
//! `forEach` callback, a getter, a generator driver), and resuming it
//! from the inner loop runs the outer frame's handler against the inner
//! frame's state — `end:frame-underflow`, or a caller pc decoded against
//! the callee's buffer. That depth test lives in exactly one place, the
//! `dispatch_halt!` macro; a hand-expanded `match self.raise_js(error)
//! { Ok(target) => { pc = target; … } }` arm silently skips it, which is
//! how eleven raise sites diverged from the `THROW` opcode's own arm.
//!
//! This test parses `interp.rs` and refuses any raise inside
//! `dispatch_at_inner` that does not go through the macro, in the same
//! shape as `gc_visitation_registry.rs`: textual, so it kills the
//! forgot-the-depth-test class outright for every future raise site.

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

/// Strip `//` comments so commented-out code never satisfies or trips a
/// check.
fn strip_comments(s: &str) -> String {
    s.lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The 1-based line of byte offset `at` within `hay`, for messages.
fn line_of(hay: &str, at: usize) -> usize {
    hay[..at].matches('\n').count() + 1
}

/// Every byte offset of `needle` in `hay`.
fn occurrences(hay: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut start = 0;
    while let Some(p) = hay[start..].find(needle) {
        out.push(start + p);
        start += p + needle.len();
    }
    out
}

/// The non-whitespace text immediately before offset `at`, at most `n`
/// bytes of it.
fn preceding_text(hay: &str, at: usize, n: usize) -> &str {
    let trimmed = hay[..at].trim_end();
    &trimmed[trimmed.len().saturating_sub(n)..]
}

fn dispatch_loop() -> String {
    strip_comments(fn_body("fn dispatch_at_inner("))
}

#[test]
fn raise_js_yields_a_halt_so_no_site_can_hand_expand_the_caught_arm() {
    // The signature is the mechanism: a `Result<usize, Halt>` invited every
    // site to match `Ok(target)` and assign `pc` itself.
    let sig = fn_body("fn raise_js(");
    let decl_start = SRC.find("fn raise_js(").unwrap();
    let decl = &SRC[decl_start..decl_start + sig.len().min(200)];
    let head = SRC[decl_start..].split('{').next().unwrap();
    assert!(
        head.contains("-> Halt"),
        "raise_js must return a bare Halt (Resume or Throw), got: {head}"
    );
    let _ = decl;
    let src = strip_comments(SRC);
    assert!(
        !src.contains("match self.raise_js("),
        "a hand-expanded `match self.raise_js(` arm remains at line {}; \
         route it through dispatch_halt! (in the loop) or return the Halt",
        src.find("match self.raise_js(")
            .map(|p| line_of(&src, p))
            .unwrap_or(0)
    );
}

#[test]
fn every_raise_in_the_dispatch_loop_goes_through_dispatch_halt() {
    let body = dispatch_loop();
    let raisers = [
        "self.raise_js(",
        "self.catchable_type_error(",
        "self.catchable_type_error_msg(",
        "self.catchable_range_error(",
        "self.catchable_range_error_msg(",
        "self.catchable_syntax_error(",
        "self.catchable_syntax_error_msg(",
    ];
    let mut bad = Vec::new();
    let mut seen = 0usize;
    for raiser in raisers {
        for at in occurrences(&body, raiser) {
            seen += 1;
            let before = preceding_text(&body, at, 16);
            if !before.ends_with("dispatch_halt!(") {
                bad.push(format!(
                    "  loop line {}: `{}` preceded by `{}`",
                    line_of(&body, at),
                    raiser,
                    before
                ));
            }
        }
    }
    assert!(
        seen > 20,
        "expected the dispatch loop to raise in many places; found {seen} \
         (did the marker or the helper names move?)"
    );
    assert!(
        bad.is_empty(),
        "raise sites in dispatch_at_inner that bypass dispatch_halt! (they skip \
         the return_depth test and the catch-landing meter check):\n{}",
        bad.join("\n")
    );
}

#[test]
fn a_resume_leaves_the_dispatch_loop_only_after_the_depth_test() {
    // The `THROW`/`RETHROW`/rejected-`await` arms unwind inline; the only
    // legitimate `return Halt::Resume(..)` in the loop is theirs, guarded by
    // the same `call_stack.len() < return_depth` test the macro applies.
    let body = dispatch_loop();
    let mut bad = Vec::new();
    for at in occurrences(&body, "return Halt::Resume(") {
        let window = preceding_text(&body, at, 80);
        if !window.contains("self.call_stack.len() < return_depth") {
            bad.push(format!("  loop line {}", line_of(&body, at)));
        }
    }
    assert!(
        bad.is_empty(),
        "`return Halt::Resume` without the return_depth guard in \
         dispatch_at_inner:\n{}",
        bad.join("\n")
    );
}
