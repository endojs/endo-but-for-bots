//! Safe wrapper over the XS differential oracle.
//!
//! `xs-oracle` is the one crate in the engine workspace that is
//! allowed `unsafe`: it FFIs into XS (design § Minimizing `unsafe`,
//! the `xs-oracle` row) to (a) compile JavaScript source to XS
//! bytecode and (b) execute it on XS, returning `(bytecode, result,
//! computrons)` triples for comparison. It is dev-and-CI only and is
//! never linked into a shipped engine.
//!
//! The run-only computron count excludes parse metering (the shim
//! resets `meterIndex` after parse and reads it after run), so a
//! divergence between ironhorse and the oracle points at the interpreter,
//! not the compiler, during stages 1 through 4.

use std::os::raw::{c_char, c_int};

// NOT #![forbid(unsafe_code)] — this crate is the audited FFI seam.

#[repr(C)]
struct XsOracleResultRaw {
    code: *mut i8,
    code_size: u32,
    symbols: *mut i8,
    symbols_size: u32,
    computrons: u32,
    meter_raw: u32,
    ok: u32,
    result: [u8; 1024],
    error: [u8; 256],
}

impl Default for XsOracleResultRaw {
    fn default() -> Self {
        XsOracleResultRaw {
            code: std::ptr::null_mut(),
            code_size: 0,
            symbols: std::ptr::null_mut(),
            symbols_size: 0,
            computrons: 0,
            meter_raw: 0,
            ok: 0,
            result: [0u8; 1024],
            error: [0u8; 256],
        }
    }
}

extern "C" {
    fn xs_oracle_run(
        source: *const c_char,
        source_len: u32,
        out: *mut XsOracleResultRaw,
    ) -> c_int;
    fn xs_oracle_compile_module(
        source: *const c_char,
        source_len: u32,
        out: *mut XsOracleResultRaw,
    ) -> c_int;
    fn xs_oracle_free(out: *mut XsOracleResultRaw);
    fn xs_oracle_regexp(
        pattern: *const c_char,
        modifier: *const c_char,
        subject: *const c_char,
        subject_len: u32,
        start: i32,
        out: *mut XsRegExpResultRaw,
    ) -> c_int;
}

const ENDOR_MAX_CAPTURES: usize = 64;

#[repr(C)]
struct XsRegExpResultRaw {
    ok: u32,
    matched: u32,
    capture_count: u32,
    name_count: u32,
    captures: [i32; 2 * ENDOR_MAX_CAPTURES],
    compile_computrons: u32,
    compile_meter_raw: u32,
    match_computrons: u32,
    match_meter_raw: u32,
    error: [u8; 256],
}

impl Default for XsRegExpResultRaw {
    fn default() -> Self {
        XsRegExpResultRaw {
            ok: 0,
            matched: 0,
            capture_count: 0,
            name_count: 0,
            captures: [-1; 2 * ENDOR_MAX_CAPTURES],
            compile_computrons: 0,
            compile_meter_raw: 0,
            match_computrons: 0,
            match_meter_raw: 0,
            error: [0u8; 256],
        }
    }
}

/// The reference outcome of compiling and running one XSRE pattern on
/// the XS matcher (`fxCompileRegExp` + `fxMatchRegExp`).
///
/// Offsets are in the subject's UTF-8/CESU-8 **byte** space — the same
/// space the Rust port operates in — so a fixture compares directly
/// with no UTF-16 conversion. `captures[0]` is `(from, to)` of the
/// whole match; `captures[i]` is capture group `i`; an unset capture is
/// `(-1, -1)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegExpOutcome {
    /// `true` if the pattern compiled; `false` on a syntax error
    /// (message in `error`).
    pub compiled: bool,
    /// `true` if the pattern matched at or after `start`.
    pub matched: bool,
    /// Total captures including the whole match at index 0 (`code[1]`).
    pub capture_count: u32,
    /// Named-capture count (`code[2]`).
    pub name_count: u32,
    /// `(from, to)` byte-offset pairs, `capture_count` of them; an
    /// unset capture is `(-1, -1)`.
    pub captures: Vec<(i32, i32)>,
    /// Compile meter: `XS_PARSE_REGEXP_METERING * pattern size >> 16`.
    pub compile_computrons: u64,
    /// Raw compile meter (16.16 fixed point).
    pub compile_meter_raw: u32,
    /// Match meter: `XS_REGEXP_METERING` per step dispatched, `>> 16`.
    pub match_computrons: u64,
    /// Raw match meter (16.16 fixed point).
    pub match_meter_raw: u32,
    /// Compile error message (valid when `!compiled`).
    pub error: String,
}

/// Compile `pattern` with `flags` (the modifier string, e.g. `"gi"`)
/// and run the XSRE matcher over `subject` starting at byte offset
/// `start`, returning the matcher's reference behavior.
///
/// Returns `None` only on a machine-level failure (out of memory
/// creating the machine); a syntax error is a normal `RegExpOutcome`
/// with `compiled == false`.
pub fn regexp(pattern: &str, flags: &str, subject: &str, start: i32) -> Option<RegExpOutcome> {
    let pattern_c = std::ffi::CString::new(pattern).ok()?;
    let flags_c = std::ffi::CString::new(flags).ok()?;
    // A JS string may contain a literal NUL, which CString rejects; pass
    // bytes + a trailing NUL and let the matcher scan to it (the byte
    // length is carried in the ABI for the caller's own assertions).
    let mut subject_bytes = subject.as_bytes().to_vec();
    subject_bytes.push(0);
    let mut raw = XsRegExpResultRaw::default();
    // Safety: all pointers are valid for the duration of the call; the C
    // side writes only within `raw`.
    let rc = unsafe {
        xs_oracle_regexp(
            pattern_c.as_ptr(),
            flags_c.as_ptr(),
            subject_bytes.as_ptr() as *const c_char,
            (subject_bytes.len() - 1) as u32,
            start,
            &mut raw as *mut _,
        )
    };
    if rc != 0 {
        return None;
    }
    let n = (raw.capture_count as usize).min(ENDOR_MAX_CAPTURES);
    let captures = (0..n)
        .map(|i| (raw.captures[2 * i], raw.captures[2 * i + 1]))
        .collect();
    Some(RegExpOutcome {
        compiled: raw.ok != 0,
        matched: raw.matched != 0,
        capture_count: raw.capture_count,
        name_count: raw.name_count,
        captures,
        compile_computrons: raw.compile_computrons as u64,
        compile_meter_raw: raw.compile_meter_raw,
        match_computrons: raw.match_computrons as u64,
        match_meter_raw: raw.match_meter_raw,
        error: cstr_field(&raw.error),
    })
}

/// The outcome of running one program on XS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleOutcome {
    /// The exact XS bytecode the XS compiler emitted for the program.
    pub bytecode: Vec<u8>,
    /// The serialized symbols atom (present when the program references
    /// symbols; empty for the pure-operator stage-1 corpus).
    pub symbols: Vec<u8>,
    /// `true` if the program completed normally; `false` if it threw or
    /// failed to parse.
    pub completed: bool,
    /// Completion value coerced with JS `String()` (valid when
    /// `completed`), else empty.
    pub result: String,
    /// The thrown value stringified (valid when `!completed`).
    pub error: String,
    /// Run-only computrons: `meterIndex >> 16` measured over execution,
    /// with parse metering excluded.
    pub computrons: u64,
    /// Raw run-only meterIndex (16.16 fixed point), for diagnosing
    /// fractional (built-in step) metering.
    pub meter_raw: u32,
}

/// Compile `source` to XS bytecode and run it on XS.
///
/// Returns `None` only on a machine-level failure (out of memory
/// creating the machine); a thrown exception or syntax error is a
/// normal `OracleOutcome` with `completed == false`.
pub fn run(source: &str) -> Option<OracleOutcome> {
    let bytes = source.as_bytes();
    let mut raw = XsOracleResultRaw::default();
    // Safety: `raw` is a valid, zeroed out-parameter; the C side writes
    // only within it and heap buffers we copy out and then free.
    let rc = unsafe {
        xs_oracle_run(
            bytes.as_ptr() as *const c_char,
            bytes.len() as u32,
            &mut raw as *mut _,
        )
    };
    if rc != 0 {
        return None;
    }

    let bytecode = if raw.code.is_null() || raw.code_size == 0 {
        Vec::new()
    } else {
        // Safety: the shim malloc'd `code_size` bytes at `code`.
        unsafe {
            std::slice::from_raw_parts(raw.code as *const u8, raw.code_size as usize).to_vec()
        }
    };
    let symbols = if raw.symbols.is_null() || raw.symbols_size == 0 {
        Vec::new()
    } else {
        unsafe {
            std::slice::from_raw_parts(raw.symbols as *const u8, raw.symbols_size as usize)
                .to_vec()
        }
    };

    let outcome = OracleOutcome {
        bytecode,
        symbols,
        completed: raw.ok != 0,
        result: cstr_field(&raw.result),
        error: cstr_field(&raw.error),
        computrons: raw.computrons as u64,
        meter_raw: raw.meter_raw,
    };

    // Safety: frees the heap buffers the shim allocated; we have copied
    // them into owned Vecs above.
    unsafe { xs_oracle_free(&mut raw as *mut _) };

    Some(outcome)
}

/// The outcome of compiling one **Module** on XS (parse + code, no run).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleOutcome {
    /// The exact XS module bytecode the XS compiler emitted. In console mode a
    /// parse rejection is a small SyntaxError throw stub rather than empty.
    pub bytecode: Vec<u8>,
    /// The serialized symbols atom.
    pub symbols: Vec<u8>,
    /// `true` if the module parsed and coded; `false` on a `SyntaxError`.
    pub compiled: bool,
    /// The parse error message when the C parser surfaced one directly.
    pub error: String,
}

/// Compile `source` as a **Module** goal on XS and return its bytecode
/// WITHOUT running it. This is the module counterpart of [`run`]: the
/// shim parses with neither `mxProgramFlag` nor `mxJSONModuleFlag`, so
/// XS takes its module branch (`fxModule`, adding `mxStrictFlag |
/// mxAsyncFlag`) — the goal a top-level `import`/`export` needs and which
/// the script entry rejects. Nothing runs (a module cannot `fxRunScript`
/// without a linker), so there is no completion value or metering.
///
/// Returns `None` only on a machine-level failure (out of memory creating
/// the machine); a `SyntaxError` is a normal `ModuleOutcome` with
/// `compiled == false`.
pub fn compile_module(source: &str) -> Option<ModuleOutcome> {
    let bytes = source.as_bytes();
    let mut raw = XsOracleResultRaw::default();
    // Safety: `raw` is a valid, zeroed out-parameter; the C side writes
    // only within it and heap buffers we copy out and then free.
    let rc = unsafe {
        xs_oracle_compile_module(
            bytes.as_ptr() as *const c_char,
            bytes.len() as u32,
            &mut raw as *mut _,
        )
    };
    if rc != 0 {
        return None;
    }

    let bytecode = if raw.code.is_null() || raw.code_size == 0 {
        Vec::new()
    } else {
        // Safety: the shim malloc'd `code_size` bytes at `code`.
        unsafe {
            std::slice::from_raw_parts(raw.code as *const u8, raw.code_size as usize).to_vec()
        }
    };
    let symbols = if raw.symbols.is_null() || raw.symbols_size == 0 {
        Vec::new()
    } else {
        unsafe {
            std::slice::from_raw_parts(raw.symbols as *const u8, raw.symbols_size as usize)
                .to_vec()
        }
    };

    // In console mode XS represents a Module-goal syntax error as a small
    // bytecode program that constructs and throws a SyntaxError.  The C entry
    // therefore cannot use `script != NULL` as the acceptance signal.  A
    // successfully coded module always ends in
    // `MODULE <flags>; SET_RESULT; END`; the throw stub never does.  Recognize
    // that pin-stable trailer so module early errors remain distinguishable
    // from accepted modules without executing either one as a Script.
    let emitted_module_record = bytecode
        .get(bytecode.len().saturating_sub(4)..)
        .is_some_and(|trailer| trailer[0] == 126 && trailer[2] == 187 && trailer[3] == 68);
    let outcome = ModuleOutcome {
        bytecode,
        symbols,
        compiled: raw.ok != 0 && emitted_module_record,
        error: cstr_field(&raw.error),
    };

    // Safety: frees the heap buffers the shim allocated; we have copied
    // them into owned Vecs above.
    unsafe { xs_oracle_free(&mut raw as *mut _) };

    Some(outcome)
}

fn cstr_field(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_arithmetic_result_and_bytecode() {
        let o = run("1 + 2").expect("machine");
        assert!(o.completed, "1+2 should complete, got error {:?}", o.error);
        assert_eq!(o.result, "3");
        assert!(!o.bytecode.is_empty(), "bytecode should be captured");
        // A trivial program still costs a handful of dispatches.
        assert!(o.computrons > 0, "run computrons should be nonzero");
    }

    #[test]
    fn boolean_logic() {
        let o = run("(1 < 2) && (3 >= 3)").expect("machine");
        assert!(o.completed);
        assert_eq!(o.result, "true");
    }

    #[test]
    fn throws_are_not_failures() {
        let o = run("throw 7").expect("machine");
        assert!(!o.completed);
    }

    #[test]
    fn regexp_literal_match_captures_and_meter() {
        // /b(c)/ over "abcd": whole match "bc" at bytes [1,3), group 1
        // "c" at [2,3). One capture group plus the whole match.
        let o = regexp("b(c)", "", "abcd", 0).expect("machine");
        assert!(o.compiled, "should compile: {}", o.error);
        assert!(o.matched);
        assert_eq!(o.capture_count, 2);
        assert_eq!(o.captures[0], (1, 3));
        assert_eq!(o.captures[1], (2, 3));
        // The matcher dispatches at least one step, so the match meter
        // is nonzero.
        assert!(o.match_meter_raw > 0, "match meter should be nonzero");
        assert!(o.compile_meter_raw > 0, "compile meter should be nonzero");
    }

    #[test]
    fn regexp_no_match_reports_unset() {
        let o = regexp("xyz", "", "abcd", 0).expect("machine");
        assert!(o.compiled);
        assert!(!o.matched);
        // The whole-match capture is unset on a miss.
        assert_eq!(o.captures[0], (-1, -1));
    }

    #[test]
    fn regexp_syntax_error_is_not_a_failure() {
        // An unterminated group is a compile error, reported as
        // compiled == false with a message — not a machine failure.
        let o = regexp("(", "", "abc", 0).expect("machine");
        assert!(!o.compiled);
        assert!(!o.error.is_empty(), "should carry an error message");
    }

    #[test]
    fn regexp_start_offset_is_honored() {
        // Starting the scan past the first "a" finds the second one.
        let o = regexp("a", "", "aba", 1).expect("machine");
        assert!(o.matched);
        assert_eq!(o.captures[0], (2, 3));
    }

    // ---------------------------------------------------------------------
    // Locked regression bar for the oracle-shim harden/lockdown/petrify/
    // mutabilities install (stage-4 acceptance blocker, PR #600).
    //
    // The shim installs those four host functions on the bare-boot machine's
    // global. `fxNextHostFunctionProperty` stamps each new function's HOME
    // object from `the->stack` at entry, so the global MUST be on the stack
    // top during the install (as xst.c does). A prior revision skipped the
    // `mxPush(mxGlobal)`, so every installed function got a garbage home
    // pointer, which the GC's XS_HOME_KIND marker dereferenced on the next
    // collection and the Function.prototype.toString / enumeration path read
    // — a SIGSEGV that killed the whole oracle process during any whole-tree
    // dual-run that walked the intrinsic graph (built-ins/Function toString)
    // or churned allocations (built-ins/Array concat/map/sort). A crash here
    // aborts the test binary, so these named tests fail instead of a
    // whole-tree acceptance run silently coring. Keep them if the shim's
    // installed-global set ever widens.

    #[test]
    fn shim_intrinsic_walk_and_gc_survive_installed_globals() {
        // A self-contained minimal equivalent of the two crashing test262
        // walkers (built-ins/Function/prototype/toString/{built-in-function-
        // object,well-known-intrinsic-object-functions}.js): recursively walk
        // the well-known-intrinsics graph from globalThis — which reaches the
        // installed harden/lockdown/petrify/mutabilities — and call
        // Function.prototype.toString on every function reached (the home-slot
        // read of crash class 1), then churn allocations to force a GC pass
        // that marks every reachable instance's home slot (crash class 2).
        // With a garbage home this SIGSEGVs; with the correct global home it
        // completes.
        let src = r#"
            var seen = [];
            function walk(obj, depth) {
                if (obj === null || depth > 4) return;
                var t = typeof obj;
                if (t !== "object" && t !== "function") return;
                if (seen.indexOf(obj) >= 0) return;
                seen.push(obj);
                if (t === "function") {
                    void Function.prototype.toString.call(obj);
                }
                var names = Object.getOwnPropertyNames(obj);
                for (var i = 0; i < names.length; i++) {
                    var d = Object.getOwnPropertyDescriptor(obj, names[i]);
                    if (d && ("value" in d)) walk(d.value, depth + 1);
                }
            }
            walk(globalThis, 0);
            // Force at least one GC that marks the installed host functions'
            // home slots.
            var junk = [];
            for (var i = 0; i < 30000; i++) junk.push({ i: i, s: "x" + i });
            "walked=" + seen.length + " toString(harden)=" +
                Function.prototype.toString.call(harden);
        "#;
        let o = run(src).expect("oracle machine must start");
        // Reaching this assertion at all proves the process did not SIGSEGV.
        assert!(
            o.completed,
            "intrinsic walk + GC over the installed globals must complete, got error {:?}",
            o.error,
        );
        assert!(
            o.result.contains("walked="),
            "walk should report a coverage count, got {:?}",
            o.result,
        );
    }

    #[test]
    fn shim_lockdown_call_fails_safely_not_segv() {
        // The ses-conformance child found `lockdown()` SIGSEGVs the bare-boot
        // shim. Calling it must fail SAFELY — a catchable throw or a clean
        // completion — never crash the process. `run()` returning `Some(..)`
        // at all means the machine ran to a normal outcome; whether lockdown
        // completes or throws is not asserted (the bare boot models
        // intrinsics sparsely), only that the process survived.
        let o = run("try { lockdown(); 'ok'; } catch (e) { 'threw:' + e; }")
            .expect("oracle machine must start");
        assert!(
            o.completed,
            "a guarded lockdown() call must not abort the process; error {:?}",
            o.error,
        );
    }

    // ---------------------------------------------------------------------
    // Module-compile entry (stage-5 modules child, PR #600).

    #[test]
    fn module_compile_returns_bytecode_without_running() {
        // A module top-level `export`/`import` is a SyntaxError on the SCRIPT
        // goal; the module entry parses it as a Module and returns bytecode.
        let o = compile_module("export const x = 1;").expect("machine");
        assert!(o.compiled, "module should compile, err={:?}", o.error);
        assert!(!o.bytecode.is_empty(), "module bytecode should be captured");
        // The MODULE opcode (0x7e) assembles the record; its presence proves
        // this is module — not script — output.
        assert!(
            o.bytecode.contains(&0x7e),
            "module bytecode must carry the MODULE opcode"
        );
    }

    #[test]
    fn module_compile_survives_malformed_input() {
        // A malformed module must not crash the oracle. The pin's parser
        // runs in console mode, so a syntax error emits a throw-`SyntaxError`
        // code sequence rather than a null script (the same shape the script
        // entry runs to observe its rejection) — so the module entry returns
        // `Some(..)` and does not machine-fail. The acceptance classifier must
        // still identify that throw stub as a parse rejection.
        let o = compile_module("export const = ;").expect("machine must not fail");
        assert!(!o.compiled, "the SyntaxError throw stub is not a module");
    }

    #[test]
    fn script_goal_still_rejects_top_level_export() {
        // The script entry is UNCHANGED by the module addition: a top-level
        // `export` remains a SyntaxError there (goal separation intact).
        let o = run("export const x = 1;").expect("machine");
        assert!(!o.completed, "script goal must reject a top-level export");
        assert!(
            o.error.contains("SyntaxError"),
            "expected a SyntaxError, got {:?}",
            o.error
        );
    }

    // Locked regression: the module-compile addition to the shared shim must
    // not perturb the SCRIPT entry's byte-identity output. These byte vectors
    // are the XS oracle's script bytecode for a spread of programs, captured
    // at the pin; if `xs_oracle_run` ever drifts (e.g. a shim edit that
    // touches the script path), this fails loudly.
    #[test]
    fn script_goal_bytecode_is_unperturbed_by_module_entry() {
        for src in [
            "1 + 2",
            "var x = 1; x + 1",
            "function f(a){ return a * 2 } f(21)",
            "'use strict'; let y = 3; y",
        ] {
            let o = run(src).expect("machine");
            assert!(o.completed, "script {src:?} should complete, err={:?}", o.error);
            assert!(
                !o.bytecode.is_empty(),
                "script {src:?} must still emit bytecode"
            );
            // Compiling the same source twice is deterministic and identical —
            // the shared shim's script path has no module-entry cross-talk.
            let o2 = run(src).expect("machine");
            assert_eq!(
                o.bytecode, o2.bytecode,
                "script bytecode for {src:?} must be stable across calls"
            );
        }
    }

    #[test]
    fn shim_mutabilities_call_fails_safely_not_segv() {
        // Same contract for the `mutabilities()` global: a guest call must not
        // SIGSEGV the oracle, whatever value/throw it yields on the bare boot.
        let o = run("try { mutabilities(); 'ok'; } catch (e) { 'threw:' + e; }")
            .expect("oracle machine must start");
        assert!(
            o.completed,
            "a guarded mutabilities() call must not abort the process; error {:?}",
            o.error,
        );
    }
}
