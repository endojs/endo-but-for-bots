//! Byte-identity: `ironhorse_compile::compile_with(src, false)` must equal
//! `xs_oracle::run(src).bytecode` byte for byte on a corpus of
//! expression + simple-statement programs (stage-5 child 5/7 bar).
//!
//! XS's coder is the ground truth: node shapes, operand widths, branch
//! sizing, and the constant encodings all leak into the bytes, so a
//! single wrong byte fails the test. On divergence the harness prints an
//! **opcode-level diff** from a small disassembler — a triage tool that
//! pays for itself the first time a width or a branch displacement is off.
//!
//! The entry compared is the **eval goal** (`compile_with`), because that
//! is the goal the oracle shim compiles every source as
//! (`fxParseScript(..., mxProgramFlag | mxEvalFlag)`, the `eval` builtin's
//! flags). ironhorse's **Script goal** (`compile`, what a top-level program
//! runs as) deviates from those bytes in exactly one known place: a
//! *strict* program's top-level `var`/function declarations hoist to the
//! global object (ECMA-262 GlobalDeclarationInstantiation; `xst`'s
//! `mxProgramFlag`-only parse) where the strict *eval* program XS codes
//! keeps them as frame locals. [`assert_identical`] locks that
//! characterization over the whole corpus, and
//! [`strict_script_hoists_top_level_declarations`] pins the exact shape.

use ironhorse_compile::{compile, compile_module, compile_with, opcodes};

// --------------------------- disassembler ----------------------------
//
// A minimal XS-bytecode disassembler for triage. It knows just enough of
// the operand grammar to line up two byte streams opcode-by-opcode; it is
// not part of the byte-identity contract, only the failure message.

/// Opcode name + operand size class, generated the same way the coder's
/// `opcodes` module is (from the pin's opcode table). We keep a compact
/// hand table of the names the ported surface can emit; anything else
/// prints as `?<byte>` with a best-effort length so the diff still aligns
/// on fixed-size ops.
fn disasm(code: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut pc = 0usize;
    while pc < code.len() {
        let op = code[pc];
        let (name, operand) = decode(op, code, pc);
        out.push(format!("{:04} {}{}", pc, name, operand.text));
        pc += 1 + operand.len;
    }
    out
}

struct Operand {
    len: usize,
    text: String,
}

fn decode(op: u8, code: &[u8], pc: usize) -> (&'static str, Operand) {
    use ironhorse_compile::opcodes as x;
    let o = op as i32;
    let i8_at = |k: usize| code.get(pc + k).map(|b| *b as i8 as i32).unwrap_or(0);
    let i16_at = |k: usize| {
        let a = *code.get(pc + k).unwrap_or(&0);
        let b = *code.get(pc + k + 1).unwrap_or(&0);
        i16::from_le_bytes([a, b]) as i32
    };
    let name_of = |o: i32| -> &'static str { op_name(o) };
    // branch (_1/_2/_4)
    let branch1 = [
        x::XS_CODE_BRANCH_1, x::XS_CODE_BRANCH_CHAIN_1, x::XS_CODE_BRANCH_COALESCE_1,
        x::XS_CODE_BRANCH_ELSE_1, x::XS_CODE_BRANCH_IF_1, x::XS_CODE_BRANCH_STATUS_1,
    ];
    if branch1.contains(&o) {
        return (name_of(o), Operand { len: 1, text: format!(" {:+}", i8_at(1)) });
    }
    if branch1.iter().any(|b| *b + 1 == o) {
        return (name_of(o), Operand { len: 2, text: format!(" {:+}", i16_at(1)) });
    }
    match o {
        x::XS_CODE_INTEGER_1 => (name_of(o), Operand { len: 1, text: format!(" {}", i8_at(1)) }),
        x::XS_CODE_INTEGER_2 => (name_of(o), Operand { len: 2, text: format!(" {}", i16_at(1)) }),
        x::XS_CODE_INTEGER_4 => (name_of(o), Operand { len: 4, text: String::from(" i32") }),
        x::XS_CODE_NUMBER => (name_of(o), Operand { len: 8, text: String::from(" f64") }),
        x::XS_CODE_STRING_1 => {
            let n = *code.get(pc + 1).unwrap_or(&0) as usize;
            (name_of(o), Operand { len: 1 + n, text: format!(" [{}]", n) })
        }
        x::XS_CODE_BEGIN_SLOPPY | x::XS_CODE_BEGIN_STRICT | x::XS_CODE_BEGIN_STRICT_BASE
        | x::XS_CODE_BEGIN_STRICT_DERIVED | x::XS_CODE_BEGIN_STRICT_FIELD => {
            (name_of(o), Operand { len: 1, text: format!(" {}", code.get(pc + 1).copied().unwrap_or(0)) })
        }
        x::XS_CODE_RESERVE_1 | x::XS_CODE_UNWIND_1 => {
            (name_of(o), Operand { len: 1, text: format!(" #{}", code.get(pc + 1).copied().unwrap_or(0)) })
        }
        _ => (name_of(o), Operand { len: 0, text: String::new() }),
    }
}

/// Reverse the opcodes const table into a name. Cheap linear scan (the
/// disassembler runs only on failure).
fn op_name(o: i32) -> &'static str {
    macro_rules! names { ($($n:ident),* $(,)?) => {
        match o { $( x if x == ironhorse_compile::opcodes::$n => stringify!($n), )* _ => "?" }
    }}
    names!(
        XS_NO_CODE, XS_CODE_ADD, XS_CODE_SUBTRACT, XS_CODE_MULTIPLY, XS_CODE_DIVIDE,
        XS_CODE_MODULO, XS_CODE_EXPONENTIATION, XS_CODE_BIT_AND, XS_CODE_BIT_OR,
        XS_CODE_BIT_XOR, XS_CODE_BIT_NOT, XS_CODE_LEFT_SHIFT, XS_CODE_SIGNED_RIGHT_SHIFT,
        XS_CODE_UNSIGNED_RIGHT_SHIFT, XS_CODE_EQUAL, XS_CODE_NOT_EQUAL, XS_CODE_STRICT_EQUAL,
        XS_CODE_STRICT_NOT_EQUAL, XS_CODE_LESS, XS_CODE_LESS_EQUAL, XS_CODE_MORE,
        XS_CODE_MORE_EQUAL, XS_CODE_INSTANCEOF, XS_CODE_IN, XS_CODE_NOT, XS_CODE_MINUS,
        XS_CODE_PLUS, XS_CODE_VOID, XS_CODE_TYPEOF, XS_CODE_TRUE, XS_CODE_FALSE,
        XS_CODE_NULL, XS_CODE_UNDEFINED, XS_CODE_INTEGER_1, XS_CODE_INTEGER_2,
        XS_CODE_INTEGER_4, XS_CODE_NUMBER, XS_CODE_STRING_1, XS_CODE_STRING_2,
        XS_CODE_BEGIN_SLOPPY, XS_CODE_BEGIN_STRICT, XS_CODE_EVAL_ENVIRONMENT,
        XS_CODE_PROGRAM_ENVIRONMENT, XS_CODE_RESERVE_1, XS_CODE_SET_RESULT, XS_CODE_RETURN,
        XS_CODE_POP, XS_CODE_DUB, XS_CODE_UNWIND_1, XS_CODE_BRANCH_1, XS_CODE_BRANCH_2,
        XS_CODE_BRANCH_ELSE_1, XS_CODE_BRANCH_ELSE_2, XS_CODE_BRANCH_IF_1, XS_CODE_BRANCH_IF_2,
        XS_CODE_BRANCH_COALESCE_1, XS_CODE_BRANCH_COALESCE_2,
    )
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect::<Vec<_>>().join(" ")
}

/// Whether `src` is a strict program declaring a top-level `var` or
/// function — the one program class whose Script-goal bytes deviate from
/// the eval goal's (the module doc). The compiler's own answer
/// (`ironhorse_compile::script_goal_deviates`, decided by the scoper), not
/// a byte heuristic.
fn strict_with_top_level_declarations(src: &str) -> bool {
    ironhorse_compile::script_goal_deviates(src)
}

/// Assert byte-identity for every source, printing an opcode-level diff
/// for the first few divergences. The eval-goal entry is compared (the
/// module doc says why); the Script-goal entry must then match it exactly,
/// except for a strict program with top-level `var`/function declarations,
/// where it must differ (the hoist,
/// [`strict_script_hoists_top_level_declarations`] pins the exact bytes).
fn assert_identical(corpus: &[&str]) {
    let mut fails: Vec<String> = Vec::new();
    for &src in corpus {
        let want = match xs_oracle::run(src) {
            Some(o) => o.bytecode,
            None => {
                fails.push(format!("{src:?}: oracle returned no bytecode"));
                continue;
            }
        };
        match compile(src) {
            Ok(script) => {
                let hoists = strict_with_top_level_declarations(src);
                if hoists == (script == want) {
                    fails.push(format!(
                        "{src:?} SCRIPT GOAL {} the eval goal (strict top-level hoist expected: {hoists})\n  eval   {}\n  script {}",
                        if hoists { "matches" } else { "deviates from" },
                        hex(&want),
                        hex(&script)
                    ));
                }
            }
            Err(e) => fails.push(format!("{src:?}: script-goal compile error {e:?}")),
        }
        match compile_with(src, false) {
            Ok(got) if got == want => {}
            Ok(got) => {
                let wd = disasm(&want);
                let gd = disasm(&got);
                let mut diff = String::new();
                let n = wd.len().max(gd.len());
                for i in 0..n {
                    let w = wd.get(i).map(String::as_str).unwrap_or("--");
                    let g = gd.get(i).map(String::as_str).unwrap_or("--");
                    let mark = if w == g { "  " } else { "!!" };
                    diff.push_str(&format!("    {mark} want[{w}]  got[{g}]\n"));
                }
                fails.push(format!(
                    "{src:?} MISMATCH\n  want {}\n  got  {}\n{}",
                    hex(&want),
                    hex(&got),
                    diff
                ));
            }
            Err(e) => fails.push(format!("{src:?}: compile error {e:?} (want {})", hex(&want))),
        }
    }
    if !fails.is_empty() {
        panic!("{} divergence(s):\n{}", fails.len(), fails.join("\n"));
    }
}

/// Reject-agreement lock: every source must be a SyntaxError in BOTH
/// engines — ironhorse's `compile` returns an error and the XS oracle
/// returns no bytecode (it never reaches execution). Pins a rejection
/// shape so a later change cannot silently start accepting it on one
/// side while the other still rejects.
fn assert_both_reject(corpus: &[&str]) {
    let mut fails: Vec<String> = Vec::new();
    for &src in corpus {
        let ironhorse_accepts = compile(src).is_ok();
        // `xs_oracle::run` returns `Some` even on a compile failure (an
        // uncompleted run carrying the error text), so mirror
        // `compile-diff`'s `oracle_compile`: the oracle *rejected* only when
        // the run did not complete AND the error is a `SyntaxError` (any
        // other uncompleted run is a parsed program that threw at runtime).
        let oracle_accepts = match xs_oracle::run(src) {
            None => true, // machine unavailable — do not claim a rejection
            Some(o) => o.completed || !o.error.contains("SyntaxError"),
        };
        if ironhorse_accepts || oracle_accepts {
            fails.push(format!(
                "{src:?}: ironhorse_accepts={ironhorse_accepts} oracle_accepts={oracle_accepts} (want both reject)"
            ));
        }
    }
    if !fails.is_empty() {
        panic!("{} reject-disagreement(s):\n{}", fails.len(), fails.join("\n"));
    }
}

// A malformed `\x`/`\u` escape in a *plain* string literal is a
// context-independent SyntaxError (`fxStringNodeCode`'s
// `mxStringErrorFlag` check), and a legacy octal / `\8`/`\9` escape is a
// SyntaxError only in a strict scope (`fxStringNodeHoist` upgrades
// `mxStringLegacyFlag` to `mxStringErrorFlag` once a later `"use strict"`
// prologue has flipped the enclosing scope strict). Both must reject on
// both engines; the sloppy legacy-octal forms below must still be
// ACCEPTED (they appear in `hashbang_comment`/`literals_and_operators`
// company only implicitly, so pin acceptance here too).
#[test]
fn string_escape_validation_rejects() {
    assert_both_reject(&[
        // truncated / illegal UnicodeEscapeSequence (S7.8.4_A7.*)
        r#""\u000G""#,
        r#""\u1""#,
        r#""\uA""#,
        r#""\u11""#,
        r#""\uAA""#,
        r#""\u111""#,
        r#""\uAAA""#,
        // NumericLiteralSeparator inside a `\u{…}` code point
        r#""\u{1F_639}""#,
        r#"'\u{1F_639}'"#,
        // legacy octal in a directive prologue that a later "use strict"
        // makes strict (legacy-octal-escape-sequence-prologue-strict)
        "(function() {\n  \"asterisk: \\052\";\n  \"use strict\";\n})",
        // legacy octal / \8 in strict code generally
        "\"use strict\"; var x = \"\\052\";",
        "\"use strict\"; var y = \"\\8\";",
    ]);
}

// The same legacy-octal escapes are a sloppy-mode allowance and must
// compile byte-identically to the oracle when strict mode is off.
#[test]
fn legacy_octal_sloppy_accepts() {
    assert_identical(&[
        r#""\052""#,
        r#""\7""#,
        r#""\8""#,
        r#""abc\052def""#,
    ]);
}

// A `const` (or `using`) declaration with no initializer is a SyntaxError
// (`fxDeclareNodeCode`'s "invalid const" / "invalid using") — a code-time
// check, so it fires in statement, `switch`-case, and C-style-`for`
// positions but NOT for a `for (const x of/in …)` iteration binding, which
// is coded through the reference/assign path. The accept side of that
// boundary is pinned in the curated for-of/for-in corpora; here we lock
// the rejections and the still-legal initializer-bearing / for-head forms.
#[test]
fn const_without_initializer_rejects() {
    assert_both_reject(&[
        "const x;",
        "const x = 1, y;",
        "const x, y = 1;",
        "switch (true) { case true: const x; }",
        "switch (true) { default: const x; }",
        "{ const x; }",
        "for (const x;;) {}",
    ]);
}

// The initializer-bearing statement forms and the for-in/for-of iteration
// bindings (no initializer required) must still compile byte-identically.
#[test]
fn const_with_initializer_and_for_head_accepts() {
    assert_identical(&[
        "const x = 1;",
        "const x = 1, y = 2;",
        "for (const x of [1]) { x; }",
        "for (const k in {a:1}) { k; }",
        "{ const z = 3; z; }",
    ]);
}

// In-function **direct `eval`** — the eval-scope slice (stage-5 fix2 4/6).
// A function that contains a direct `eval` publishes its parameters into a
// `with` environment (`fxScopeCodingParams`' eval branch), materializes an
// `arguments` object, and — in sloppy mode — runs the two-`with` body dance
// (`fxScopeCodingBody`) so an eval-created `var`/lexical resolves to the
// right frame. Strict differs (no leading `null` `with`, block-shaped body).
// Program- and block-level direct eval were already byte-identical; these
// fixtures pin the in-function forms: sloppy + strict, no-param / param /
// default / rest, body `var`/`let`/function declarations, function
// declarations vs expressions, and nested functions.
#[test]
fn eval_scope_in_function() {
    assert_identical(&[
        // sloppy: no params, simple params, arguments materialization
        "(function() { eval('1'); });",
        "(function(a) { eval('a'); });",
        "(function(a, b) { eval('a'); });",
        // strict: no leading `null` with; block-shaped body
        "'use strict'; (function() { eval('1'); });",
        "'use strict'; (function(a) { eval('a'); });",
        // body declarations under a sloppy eval (the two-`with` dance)
        "(function() { eval('1'); var y; });",
        "(function() { eval('1'); let z; });",
        "(function() { eval('1'); function g(){} });",
        "(function() { eval('1'); var y; let z; function g(){} });",
        "(function(a, b) { eval('a'); var y; });",
        // strict body declarations (the block path with the eval publish)
        "'use strict'; (function() { eval('1'); var y; let z; function g(){} });",
        // default / rest parameters with a body-level eval
        "(function(a = 1) { eval('a'); });",
        "(function(...a) { eval('a'); });",
        // function *declaration* (hoisted) carrying a body eval
        "function f() { let x; eval('1'); }",
        "function f() { eval('1'); var y; }",
        // nested functions: each eval marks only its own function
        "(function() { eval('1'); (function() { eval('2'); var z; }); });",
        "(function() { (function() { eval('2'); }); });",
        // `arguments` referenced/declared alongside a body eval
        "(function() { eval('1'); return arguments; });",
        "(function() { var arguments = 1; eval('1'); return arguments; });",
        // regression: a `with` poisons the scope but is NOT a direct eval —
        // no body dance, only the parameter-scope `with` publish
        "(function() { with({}) {} });",
        "(function() { with(arguments) {} return arguments; });",
    ]);
}

// A parameter literally named `arguments`. When the function references
// `arguments`, `fxFunctionNodeHoist` still injects the synthetic `arguments`
// `Var` *after* the parameter, so `fxScopeGetDeclareNode(functionScope,
// arguments)` (which `fxParamsBindingNodeCode` stores the object into) returns
// the **parameter**, not the `Var`. In the mapped (sloppy, simple-parameter)
// case the parameter is a closure slot, so the object is stored with
// `VAR_CLOSURE`, not the `Var`'s `VAR_LOCAL` — Class α, the mis-emit that
// surfaced on `statements/function/S13_A15_T1,T3`. A parameter merely *named*
// `arguments` in a function that never reads it injects no `Var` and stores no
// object (the empty-body cases).
#[test]
fn mapped_arguments_parameter_named_arguments() {
    assert_identical(&[
        // sloppy, arguments referenced → mapped: object stored into the
        // parameter's closure slot (`VAR_CLOSURE`).
        "function __func(arguments){ return arguments; }; __func(42);",
        "(function(arguments){ return arguments; });",
        "(function(arguments, b){ return arguments; });",
        // sloppy, arguments referenced, parameter NOT named arguments →
        // object stored into the synthetic `Var` (still `VAR_CLOSURE`, mapped).
        "(function(a){ return arguments; });",
        // empty body: `arguments` never referenced → no `Var`, no object.
        "function foo(arguments){}",
        // strict: not mapped (object is unmapped, parameters stay local).
        "'use strict'; (function(a){ return arguments; });",
    ]);
}

// A **nested** function containing a direct `eval` captures its ENTIRE
// enclosing lexical frame, not just the names it lexically reads:
// `fxScopeCodeStore`'s `fxScopeCodeStoreAll` walk stores every already-slotted
// enclosing declaration into the eval function's environment (so a name the
// `eval` reads at runtime resolves to the live slot). The store-all walk stops
// at the nearest enclosing function/module and skips `var`/`Define` declares in
// a sloppy `Eval`/`Program` scope (they bind to null). Class γ: the residual
// `expressions/assignment/S11.13.1_A6_T1,T2` divergence.
#[test]
fn nested_function_eval_captures_enclosing_frame() {
    assert_identical(&[
        // sloppy: the inner IIFE captures both enclosing `var`s (`a`, `b`) via
        // store-all even though it only lexically reads `a`; the outer function
        // is itself eval-poisoned but its own store-all over the eval program
        // scope finds only null-binding `var`s and emits nothing.
        "function outer() { var a = 1; var b = 2; var c = (function() { a = (eval(\"var a;\"), 1); return a + b; })(); return c; }",
        // the T1/T2 shape: `eval(\"var x;\")` in a sequence inside the IIFE.
        "function testAssignment() { var x = 0; var innerX = (function() { x = (eval(\"var x;\"), 1); return x; })(); return innerX; }",
        // strict: the inner eval function captures the enclosing `let`.
        "'use strict'; function outer() { let a = 1; return (function() { eval(\"a\"); return a; })(); }",
        // deeper nesting: two enclosing frames captured through the walk.
        "function a() { var x = 1; function b() { var y = 2; return (function() { eval(\"x\"); return x + y; })(); } return b(); }",
    ]);
}

// A direct `eval` in a **parameter default** poisons the parameter scope
// (not the body): `fxScopeCodingParams`' eval branch publishes the parameters
// into a `with` environment, and `fxScopeCodedBody` — keyed on the FUNCTION
// node's eval flag, not the body's — unwinds those `with` frames with the two
// `WITHOUT` even though the body is coded as an ordinary block. Closes the
// `scope-*-param-*-var-*` reject fold (`statements/function` 4 rejects,
// `expressions/object` 8 rejects → 0).
#[test]
fn eval_in_parameter_default() {
    assert_identical(&[
        // sloppy: eval in the first default reads a name it creates; the two
        // parameter `with` frames unwind at body end.
        "function f(a = (eval(\"var b = 1;\"), b), c = 2) { return a + c; }; f();",
        // the reject-family shape: two elem defaults, a function-valued probe.
        "var probe1, probe2; function f(_ = (eval('var x = 1;'), probe1 = function() { return x; }), __ = probe2 = function() { return x; }) {}; f();",
        // strict: no leading `null` `with`; still a parameter var-environment.
        "'use strict'; function f(a = (eval(\"a\"), 1)) { return a; }; f();",
        // a rest parameter after an eval default.
        "function f(a = (eval('1'), 2), ...rest) { return a; }; f();",
    ]);
}

#[test]
fn literals_and_operators() {
    assert_identical(&[
        // literals of every scalar kind
        "1", "0", "-0", "300", "70000", "2147483647", "1.5", "0.1", "1e300",
        "true", "false", "null", "\"\"", "\"hi\"", "\"a b c\"",
        // bigint literals (limb encoding)
        "0n", "1n", "255n", "256n", "10n", "0xdeadbeefn", "4294967295n",
        "4294967296n", "18446744073709551616n", "0o17n", "0b1010n",
        // arithmetic / precedence
        "1+2", "1-2", "1*2", "1/2", "1%2", "2**3", "1+2*3", "1*2+3", "(1+2)*3",
        "2**3**2", "1-2-3",
        // bitwise / shift
        "1&2", "1|2", "1^2", "~5", "1<<2", "8>>1", "8>>>1",
        // relational / equality
        "1<2", "1>2", "1<=2", "1>=2", "1==2", "1!=2", "1===2", "1!==2",
        // unary
        "-3", "+3", "!0", "!1", "~0", "void 0", "typeof 1", "typeof \"x\"",
    ]);
}

// A leading `#!` hashbang comment (Annex B `HashbangComment`) is stripped
// before the first token by `fxSkipShebang`, for both the program and
// module goals; ironhorse mirrors it in `Lexer::skip_shebang`, invoked from
// `Parser::new`. The program after the shebang must compile byte-identically
// to the same program without it — the hashbang contributes no bytecode and
// does not shift the line count of the first statement (the terminator is
// left for the scanner). Fixtures cover an empty hashbang, a non-empty one,
// and one whose only line terminator is a bare LF.
#[test]
fn hashbang_comment() {
    assert_identical(&[
        "#!\n1 + 2",
        "#!/usr/bin/env node\nvar x = 1; x;",
        "#! these characters should be treated as a comment\n(function(){ return 42; })()",
        "#!shebang\n\"use strict\"; var y = 3; y;",
    ]);
}

// String literals are stored in the bytecode as XS's CESU-8, NOT the Rust
// `String`'s UTF-8: an astral scalar is a 6-byte surrogate pair (each half
// a 3-byte unit), a lone surrogate is a 3-byte unit that is not valid UTF-8
// at all, and an embedded NUL is the overlong `0xC0 0x80`. The coder carries
// string values as UTF-16 code units end to end and encodes CESU-8 at emit
// (`fxCESU8Encode`), so these must be byte-identical to the oracle. Each
// fixture is an expression statement whose value the oracle can execute.
#[test]
fn strings_cesu8_astral_and_surrogates() {
    assert_identical(&[
        // astral scalar, literal in (UTF-8) source: 𝒜 = U+1D49C = D835 DC9C
        "\"𝒜\"", "\"a𝒜b\"", "\"𝒜𝒷𝒜𝒷\"",
        // astral via \u{…} and via a combined surrogate-pair escape
        "\"\\u{1D49C}\"", "\"\\uD835\\uDC9C\"", "\"a\\u{1D49C}b\"",
        // lone surrogates (WTF-16 — a JS string need not be well-formed)
        "\"\\uD834\"", "\"\\uDD1E\"", "\"A\\uD800B\"", "\"\\uD800\\uD801\"",
        // a lone high surrogate NOT combined (no low surrogate follows)
        "\"\\uD834x\"", "\"\\uD835\\u0041\"",
        // BMP two-byte / three-byte CESU-8 boundaries
        "\"\\u00A9\"", "\"\\u07FF\"", "\"\\u0800\"", "\"é\"", "\"€\"",
        // embedded NUL → overlong 0xC0 0x80 (not a raw 0x00 terminator)
        "\"a\\x00b\"", "\"\\0\"", "\"\\u0000z\"",
    ]);
}

#[test]
fn logical_conditional_sequence() {
    assert_identical(&[
        "1&&2", "1||2", "1??2", "1&&2&&3", "1||2||3", "1&&2||3", "1??2??3",
        "1?2:3", "true?1:0", "0?1:2?3:4", "1?2?3:4:5",
        "1,2", "1,2,3", "(1,2)", "(1,2)+3", "1,2?3:4",
        "1&&(2||3)", "(1||2)&&3", "1?2:3,4",
    ]);
}

#[test]
fn async_generator_return() {
    // An `async function*` return awaits and status-checks the value:
    // XS emits `AWAIT; THROW_STATUS` before `SET_RESULT`, and a bare
    // `return;` emits nothing (the resume machine supplies the result)
    // rather than the usual `UNDEFINED; SET_RESULT`. Plain generators and
    // plain async functions keep the ordinary return shape.
    assert_identical(&[
        "var o = { async *f(){ return 1; } };",
        "var o = { async *f(){ return; } };",
        "var o = { async *f(x){ return x + 1; } };",
        "class C { async *f(){ return 1; } }",
        // contrast: a plain generator / plain async keep the ordinary return
        "var o = { *f(){ return 1; } };",
        "var o = { async f(){ return 1; } };",
    ]);
}

#[test]
fn tail_call_run_tail() {
    // XS's `mxTailRecursionFlag`: a call in tail position of a strict,
    // non-generator `return` emits the `RUN_TAIL` / `EVAL_TAIL` family
    // instead of `RUN` / `EVAL`. The flag threads through the
    // short-circuit / `?:` / comma operators to the tail-position operand,
    // and is suppressed for sloppy code, generators, and returns routed
    // through a `try`/`finally` finalizer.
    assert_identical(&[
        // strict `return f()` — the tail call
        "'use strict'; function f(g){ return g(); }",
        "'use strict'; function f(g){ return g(1, 2, 3); }",
        "'use strict'; function f(g, a){ return g(...a); }",
        // the flag threads to the tail-position operand
        "'use strict'; function f(g, h){ return g() || h(); }",
        "'use strict'; function f(g, h){ return g() && h(); }",
        "'use strict'; function f(g, h){ return g() ?? h(); }",
        "'use strict'; function f(c, g, h){ return c ? g() : h(); }",
        "'use strict'; function f(g, h){ return (g(), h()); }",
        // strict class / object methods are tail-call sites too
        "class C { m(g){ return g(); } }",
        "'use strict'; var o = { m(g){ return g(); } };",
        // suppression: sloppy mode keeps the plain RUN
        "function f(g){ return g(); }",
        // suppression: a generator return is never a tail call
        "'use strict'; function* f(g){ return g(); }",
        // suppression: a return routed through `finally` is not a tail call
        "'use strict'; function f(g){ try { return g(); } finally {} }",
    ]);
}

#[test]
fn statements_if_block() {
    assert_identical(&[
        "1;", "1;2;", "1;2;3;", ";", ";;", "1;;2;",
        "{}", "{1;}", "{1;2;}", "{{1;}}", "{;}",
        "if(1)2;", "if(0)2;", "if(1)2;else 3;", "if(1){2;}else{3;}",
        "if(1)if(2)3;else 4;", "if(1)2;else if(3)4;else 5;",
        "if(1&&2)3;else 4;", "if(1?2:3)4;",
        "{if(1)2;}", "if(1){}",
    ]);
}

// NB: `xs_oracle::run` *executes* the program, so every fixture must
// terminate. Byte-identity is about compilation, not the runtime value,
// so a `while(0)` / `for(;0;)` head exercises the same emission as a
// `while(1)` head without spinning the oracle; `break` bodies also
// terminate. Both forms are covered.
#[test]
fn control_flow_loops() {
    assert_identical(&[
        // while / do-while
        "while(0)2;", "while(0);", "while(0){2;}", "while(1)break;",
        "while(0)continue;", "do 1;while(0);", "do{1;}while(0);",
        "do break;while(1);", "do continue;while(0);",
        // C-style for
        "for(;;)break;", "for(;1;)break;", "for(;0;)1;",
        "for(1;;)break;", "for(1;0;2)3;", "for(;;){1;break;}",
        "for(;0;)continue;",
        // nested loops + break/continue
        "while(1){while(2)break;break;}", "while(0){while(2)break;continue;}",
        "for(;;){for(;;)break;break;}",
    ]);
}

#[test]
fn control_flow_labels() {
    assert_identical(&[
        "a:while(1)break a;", "a:while(0)continue a;",
        "a:for(;;)break a;", "a:for(;0;)continue a;",
        "a:b:while(1)break a;", "a:b:while(0)continue b;",
        "a:while(1)while(2)break a;", "a:while(0)while(2)continue a;",
        "a:1;", "a:{1;}", "a:{break a;}",
        "foo:while(0){continue foo;}",
    ]);
}

#[test]
fn control_flow_switch() {
    assert_identical(&[
        "switch(1){}", "switch(1){case 1:break;}",
        "switch(1){case 1:2;break;case 2:3;}",
        "switch(1){default:1;}", "switch(1){case 1:break;default:2;}",
        "switch(1){case 1:case 2:3;break;default:4;}",
        "switch(1){case 1:{2;}break;}",
        "switch(1){case 1:while(2)break;break;}",
    ]);
}

#[test]
fn control_flow_throw_debugger() {
    assert_identical(&[
        "throw 1;", "throw 1+2;", "throw\"x\";", "debugger;",
        "if(1)throw 2;", "while(1)throw 2;",
    ]);
}

#[test]
fn this_and_regexp() {
    assert_identical(&[
        "this;", "this,1;", "typeof this;", "this===this;",
        "/abc/;", "/abc/g;", "/a.c/gi;", "/x/;", "/[0-9]+/m;",
        "/a/,/b/;", "if(1)/x/;",
    ]);
}

#[test]
fn global_access_and_member() {
    assert_identical(&[
        // free (global) identifier references → EVAL_REFERENCE + GET_VARIABLE
        "x;", "foo;", "x,y;", "x+y;", "x*y+z;", "typeof x;", "-x;",
        // member access → GET_PROPERTY (symbol IDs from the atom table)
        "a.b;", "a.b.c;", "foo.bar;", "x.length;", "o.a+o.b;",
        "a.b,c.d;", "obj.prototype;", "x.y.z.w;",
        // mix with built-in-symbol collisions (length/name/prototype seeded)
        "a.name;", "a.length;", "a.constructor;", "x.value.done;",
        // identifiers that are also seeded symbols used as globals
        "undefined;", "NaN;", "Infinity;",
        // longer symbol sets to exercise multi-symbol ID ordering
        "alpha.beta+gamma.delta;", "one.two.three;",
    ]);
}

#[test]
fn calls_and_computed_member() {
    assert_identical(&[
        // computed member access (symbol-free AT / GET_PROPERTY_AT)
        "a[b];", "a[0];", "a[\"k\"];", "a[b][c];", "o[i+1];", "a.b[c];",
        // global calls → CALL + RUN_1
        "f();", "f(1);", "f(1,2);", "f(1,2,3);", "g(x);", "h(x,y);",
        // method calls (receiver via DUB + GET_PROPERTY)
        "a.b();", "a.b(1);", "o.m(x,y);", "a.b.c();",
        // computed-member calls, nested calls, call results
        "a[b]();", "f()();", "f(g(1));", "a.b(c.d);",
        "console.log(1);", "Math.max(1,2,3);",
    ]);
}

#[test]
fn assignment_and_new() {
    assert_identical(&[
        // plain assignment to a global / member / computed member
        "x=1;", "x=y;", "a.b=1;", "a.b=c;", "o.x=o.y;", "a[b]=1;",
        "a[0]=x;", "x=y=1;", "a.b.c=1;", "x=1+2;",
        // compound assignment
        "x+=1;", "x-=2;", "x*=3;", "x/=2;", "x%=2;", "x**=2;",
        "x&=1;", "x|=2;", "x^=3;", "x<<=1;", "x>>=1;", "x>>>=1;",
        "a.b+=1;", "a[b]+=c;", "o.count+=1;",
        // short-circuit assignment
        "x&&=1;", "x||=2;", "x??=3;", "a.b||=c;",
        // new
        "new X;", "new X();", "new X(1);", "new X(1,2);",
        "new a.b();", "new a.b.c(1);", "x=new Y(1);",
    ]);
}

#[test]
fn increment_decrement_delete() {
    assert_identical(&[
        // postfix / prefix on variable, member, computed member
        "x++;", "x--;", "++x;", "--x;",
        "a.b++;", "a.b--;", "++a.b;", "--a.b;",
        "a[b]++;", "++a[b];", "o.count++;",
        // as sub-expressions (value used)
        "y=x++;", "y=++x;", "f(x++);", "x++ + 1;",
        // delete
        "delete a.b;", "delete a[b];", "delete a.b.c;",
        "delete x;", "delete o[i];",
    ]);
}

#[test]
fn object_and_array_literals() {
    assert_identical(&[
        // object data properties (identifier keys)
        "({});", "({a:1});", "({a:1,b:2});", "({a:x,b:y});",
        "({a:1+2,b:c.d});", "({outer:{inner:1}});",
        // computed keys
        "({[a]:1});", "({[a+b]:c});", "({x:1,[y]:2});",
        // arrays
        "[];", "[1];", "[1,2,3];", "[a,b];", "[1+2,c.d];",
        "[[1],[2]];", "[a,,b];", "[,,1];", "[1,,];",
        // mixed / nested
        "[{a:1}];", "({list:[1,2]});", "f([1,2],{a:3});",
    ]);
}

#[test]
fn untagged_templates() {
    assert_identical(&[
        "``;", "`abc`;", "`a\nb`;",
        "`${1}`;", "`a${1}`;", "`${1}b`;", "`a${1}b`;",
        "`a${1}b${2}c`;", "`${1}${2}`;", "`x${1+2}y`;",
        "`${true}`;", "`${\"s\"}`;", "`v=${1?2:3}`;",
    ]);
}

// Tagged templates (fix5 2/5, slice 1). The tagged branch of
// `fxTemplateNodeCode` builds the frozen template object once per call
// site (a `TEMPLATE_CACHE.#<tag>` lookup guards the build), fills the
// cooked `strings` and `raws` arrays via `NEW_PROPERTY_AT` with the
// frozen `DONT_DELETE|DONT_SET` flag, sets `strings.raw = raws`,
// `TEMPLATE`-freezes, caches under the per-site `#<tag>` symbol, then
// calls the tag with the object as argument 0. Every one of those bytes
// — the tag symbol id, the temporary slots, the branch displacement,
// the `RUN_1` arity — is pinned here.
#[test]
fn tagged_templates() {
    assert_identical(&[
        // no substitutions: object is the sole argument
        "var t = s => s; t`abc`;",
        "var t = s => s; t``;",
        // one and more substitutions bump the `RUN_1` arity
        "var t = (s, a) => a; t`x${1}y`;",
        "var t = (s, a, b) => a; t`${1}${2}`;",
        "var t = (s, a, b) => b; t`a${1}b${2}c`;",
        // member-reference tag exercises the receiver dance
        "var o = { t(s) { return s; } }; o.t`hi`;",
        // two sites in one program mint distinct `#0` / `#1` cache symbols
        "var t = s => s; t`a`; t`b`;",
        // cooked value is `undefined` for an illegal escape; raw is kept
        "var t = s => s.raw[0]; t`\\unicode`;",
        "var t = s => s[0]; t`\\xZZ`;",
        // a legal escape still cooks
        "var t = s => s[0]; t`a\\tb`;",
        // tail position: `return tag`...`` emits `RUN_TAIL_1`
        "var t = s => s; function f(){ return t`z`; }",
    ]);
}

#[test]
fn control_flow_try() {
    assert_identical(&[
        "try{1;}catch{2;}", "try{1;}finally{2;}",
        "try{1;}catch{2;}finally{3;}", "try{}catch{}",
        "try{}finally{}", "try{throw 1;}catch{2;}",
        "try{1;}catch{}finally{}",
        // break/continue crossing a finally (target finalization)
        "while(1){try{break;}finally{1;}}",
        "while(0){try{continue;}finally{1;}}",
        "for(;;){try{break;}finally{2;}}",
        "try{try{1;}finally{2;}}finally{3;}",
    ]);
}

// Variable declarations (child 6, declaration slice). The script goal is
// compiled as an eval program, so a sloppy-mode `var` hoists into the
// eval environment and its accesses stay on the symbol path
// (`EVAL_REFERENCE` / `SET_VARIABLE`), whereas `let` / `const` bind to
// frame slots (`NEW_LOCAL` in the scope header, `LET_LOCAL` /
// `CONST_LOCAL` / `GET_LOCAL` / `SET_LOCAL` per access). The two paths
// differ in every byte, so both are pinned.
#[test]
fn declarations_var_sloppy() {
    assert_identical(&[
        // bare + initialized `var`, single and multiple declarators
        "var x;", "var x=1;", "var x=1,y=2;", "var a=1,b=2,c=3;",
        // access, assignment, compound, delete of a hoisted var
        "var x; x;", "var x=1; x;", "var x=1; x=2;", "var x=1; x+=2;",
        "var x=1; x++;", "var x=1; delete x;", "var p=1; p=p+1;",
        // interplay with expressions the earlier slices code
        "var a=1,b=2; a+b;", "var x=1; typeof x;", "var o; o=1; o;",
    ]);
}

#[test]
fn declarations_let_const_lexical() {
    assert_identical(&[
        // program-scope lexicals bind to slots (eval program → LOCAL, not
        // the program-scope CLOSURE marking)
        "let x=1;", "const x=1;", "let x;", "let x=1,y=2;",
        "const a=1,b=2;", "let x=1; x;", "const y=2; y;", "let x; x;",
        // store / compound-store / delete into a lexical slot
        "let x=1; x=2;", "let x=1; x+=2;", "let x=1; delete x;",
        "let a=1,b=2,c=3; a+b+c;", "const a=1,b=2; a*b;",
        // lexicals feeding the expression / control-flow surface
        "let x=1; if(x)x;", "let x=1,y=2; [x,y];", "let x=1; x?x:0;",
    ]);
}

#[test]
fn declarations_strict_and_blocks() {
    assert_identical(&[
        // a `"use strict"` prologue makes the eval program strict: `var`
        // reserves and binds a slot up front like a lexical (the eval
        // goal; the Script goal hoists it — see the test below)
        "\"use strict\"; var x=1; x;", "\"use strict\"; let x=1; x;",
        "\"use strict\"; const y=2; y;", "\"use strict\"; var x=1; x=2; x;",
        "\"use strict\"; let a=1,b=2; a+b;",
        // block-scoped lexicals: the block header codes NEW_LOCAL and the
        // block tail UNWINDs the slots
        "{ let x=1; x; }", "{ const y=2; y; }", "{ let a=1,b=2; a+b; }",
        "{ let x=1; } { let x=2; }", "if(1){ let x=1; x; }",
        "while(0){ let x=1; }", "{ { let x=1; x; } }",
    ]);
}

/// The Script goal's strict top-level hoist, pinned byte for byte. A strict
/// Script's `var`/function declarations must take the sloppy hoist shape
/// (`NEW_LOCAL` + `VAR_LOCAL` prelude, `EVAL_ENVIRONMENT`, then the symbol
/// path for every access), so its bytes equal what the oracle codes for the
/// **sloppy twin** — the same source with the directive prologue neutralized
/// to a same-length plain string — after re-stamping the sloppy twin's
/// `BEGIN_SLOPPY` header and prologue string. The eval goal of the same
/// source stays byte-identical to the oracle (frame locals: `SET_LOCAL`).
///
/// The twin trick needs a program with no nested function (a nested
/// function's own prologue would be sloppy in the twin), so the function
/// declaration case is pinned at the semantic level by
/// `ironhorse-vm/tests/hardened_js_boundary.rs` and at the byte level only
/// as "deviates from the eval goal" by [`assert_identical`]'s invariant.
#[test]
fn strict_script_hoists_top_level_declarations() {
    let cases: &[(&str, &str)] = &[
        ("'use strict'; var g = 1; g = 2; g", "'use_strict'; var g = 1; g = 2; g"),
        ("'use strict'; var g = 1; globalThis.g", "'use_strict'; var g = 1; globalThis.g"),
        // Lexicals ride along in the hoist shape's lexical loop.
        ("'use strict'; var g = 1; let h = 2; g + h", "'use_strict'; var g = 1; let h = 2; g + h"),
        ("#!shebang\n\"use strict\"; var y = 3; y;", "#!shebang\n\"use_strict\"; var y = 3; y;"),
    ];
    for &(strict_src, sloppy_twin) in cases {
        assert!(strict_with_top_level_declarations(strict_src), "{strict_src:?}");
        let script = compile(strict_src).expect("script goal compiles");
        let eval = compile_with(strict_src, false).expect("eval goal compiles");
        let oracle = xs_oracle::run(strict_src).expect("oracle runs").bytecode;
        assert_eq!(hex(&eval), hex(&oracle), "{strict_src:?}: eval goal must match the oracle");
        // The sloppy twin's oracle bytes, re-stamped strict.
        let twin = xs_oracle::run(sloppy_twin).expect("oracle runs twin").bytecode;
        assert_eq!(twin[0] as i32, opcodes::XS_CODE_BEGIN_SLOPPY, "{sloppy_twin:?} is sloppy");
        let mut want = twin.clone();
        want[0] = opcodes::XS_CODE_BEGIN_STRICT as u8;
        let needle = b"use_strict";
        let at = want.windows(needle.len()).position(|w| w == needle).expect("prologue string");
        want[at..at + needle.len()].copy_from_slice(b"use strict");
        assert_eq!(
            hex(&script),
            hex(&want),
            "{strict_src:?}: the strict Script must code the sloppy hoist shape\n  script {}\n  want   {}",
            disasm(&script).join(" | "),
            disasm(&want).join(" | ")
        );
        assert_ne!(hex(&script), hex(&eval), "{strict_src:?}: the two goals must differ");
    }
    // A strict Script with nothing to hoist keeps XS's strict shape exactly.
    for src in ["'use strict'; let x = 1; x", "'use strict'; (function(){ return arguments; })"] {
        assert!(!strict_with_top_level_declarations(src), "{src:?}");
        let oracle = xs_oracle::run(src).expect("oracle runs").bytecode;
        assert_eq!(hex(&compile(src).unwrap()), hex(&oracle), "{src:?}");
    }
}

// `with` statements (child 6). The object becomes a `with` environment
// (`TO_INSTANCE` + `WITH`), the body runs with the eval flag forced on so
// its free identifiers take the symbol path, and the environment is
// popped (`WITHOUT`). `with` is a strict-mode syntax error, so only the
// sloppy shape is reachable.
#[test]
fn with_statement() {
    assert_identical(&[
        "with({})1;", "with(o)1;", "with(o)x;", "with(o){x;}",
        "with(o){x=1;}", "with(o)o.a;", "with({a:1})a;", "with(o)x+y;",
        "with(o){ while(0)break; }", "with(a)with(b)1;",
        "var o={}; with(o)a;",
    ]);
}

// Functions (child 6, first function slice). Covers plain
// (`CONSTRUCTOR_FUNCTION`) and arrow (`FUNCTION`) function *values* with
// simple bodies (expression statements and `return expr`), function
// *declarations* (`Define`, hoisted to the top of the scope), and the
// nested `CODE` block with its `BEGIN`/`END`, `FUNCTION_ENVIRONMENT`
// storing, and the plain-function `caller` own property. Deferred (and
// asserted, never mis-emitted): parameters, captured closures, named
// function expressions, name inference, generators/async, methods/
// accessors, class constructors, and control-flow / declaring bodies.
#[test]
fn function_expressions_and_declarations() {
    assert_identical(&[
        // anonymous function expressions, empty and simple bodies
        "(function(){});", "(function(){return 1;});", "(function(){1;});",
        "(function(){return;});", "(function(){1;2;});", "(function(){return 1+2;});",
        "(function(){a;b;c;});", "(function(){return a+b;});",
        // arrow functions
        "(()=>{});", "(()=>1);", "(()=>{return 2;});", "(()=>{1;});", "(()=>x);",
        // function declarations (hoisted) and their access order
        "function f(){}", "f;function f(){}", "function g(){return 3;}",
        "function f(){}function g(){}", "function k(){return \"hi\";}",
        // function as a value in non-naming positions
        "[function(){}];", "f(function(){});", "(function(){})();",
        "(function(){return 1;})();",
        // strict function expressions
        "\"use strict\";(function(){});", "\"use strict\";(()=>{});",
    ]);
}

// Function parameters (child 6, params slice). Positional parameters
// (`Arg`) each get a frame slot (`NEW_LOCAL` in `fxScopeCodingParams`)
// then bind from the incoming argument (`ARGUMENT i` / `VAR_LOCAL` / `POP`
// in `fxParamsBindingNodeCode`); `BEGIN` carries the parameter count.
// Deferred (asserted): defaults, destructuring, rest, the `arguments`
// object, and captured (closure) parameters.
#[test]
fn function_parameters() {
    assert_identical(&[
        // single and multiple positional parameters, used and unused
        "(function(a){});", "(function(a){return a;});", "(function(a){a;});",
        "(function(a,b){return a;});", "(function(a,b){b;a;});",
        "(function(a,b,c){return a+b+c;});", "(function(first,second){return second;});",
        // parameters feeding expressions
        "(function(a){return a+1;});", "(function(x){return x*x;});",
        // arrow parameters
        "(a=>a);", "(a=>a+1);", "((a,b)=>a);", "(a=>{return a;});",
        // called (argument binding exercised end to end)
        "(function(x){return x;})(5);",
    ]);
}

// Name inference (child 6). An anonymous function assigned to a simple
// identifier — a `var`/`let`/`const` binding initializer or a plain
// assignment — takes that identifier as its name, which lands directly in
// the `CONSTRUCTOR_FUNCTION` / `FUNCTION` operand (XS sets `node->symbol`
// before coding the value). Deferred: object-method/property naming (the
// `NAME`-op path), member-target assignment, and anonymous classes.
#[test]
fn function_name_inference() {
    assert_identical(&[
        // binding initializers
        "var f=function(){};", "let g=function(){};", "const c=function(){};",
        "var f=function(){return 1;};", "var fn=function(a,b){return a+b;};",
        "var a=function(){},b=function(){};", "var f=(function(){});",
        // arrow bindings
        "let h=()=>1;", "var k=()=>{};", "let m=(a)=>a;", "let id=x=>x;",
        // assignment to an identifier
        "x=function(){};", "x=()=>{};",
    ]);
}

// NamedEvaluation for a destructuring-default initializer (stage-5 fix2,
// Class A). When an anonymous function/arrow/class/generator is the `=
// default` of a pattern element, XS renames it after the bound identifier
// at bind time (`fxBindingNodeBind`/`fxAssignNodeBind` →
// `fxFunctionNodeRename`); the port stages the same name in
// `code_assign`'s `Binding` arm. Both binding patterns (declaration, catch
// param, function param, for-of/for-in heads) and assignment patterns must
// name; a member / nested-pattern target must NOT (stays anonymous).
#[test]
fn destructuring_default_name_inference() {
    assert_identical(&[
        // object binding-pattern defaults, all four value kinds
        "var {a=function(){}}=({});", "let {b=()=>{}}=({});",
        "const {c=class{}}=({});", "var {d=function*(){}}=({});",
        "var {e=async function(){}}=({});", "let {f=async()=>{}}=({});",
        // array binding-pattern defaults
        "var [g=function(){}]=[];", "let [h=()=>{}]=[];", "const [i=class{}]=[];",
        // renamed object property with a defaulted anonymous value
        "var {p:q=function(){}}=({});", "let {p:r=()=>{}}=({});",
        // parenthesized initializer forwards to its inner value
        "var {s=(function(){})}=({});",
        // catch parameter pattern default
        "try{throw {};}catch({arrow=()=>{}}){}",
        "try{throw {};}catch({fn=function(){}}){}",
        // function parameter pattern defaults
        "(function({a=function(){}}){});", "(({b=()=>{}})=>{});",
        "(function([c=class{}]){});",
        // assignment-pattern (not declaration) defaults
        "({a=function(){}}={});", "[b=()=>{}]=[];", "({c=class{}}={});",
        "({p:q=function(){}}={});",
        // for-of / for-in heads with a defaulted pattern binding
        "for(var {a=()=>{}} of []){}", "for(let [b=function(){}] of []){}",
        "for(const {c=class{}} of []){}",
        // NOT named: a nested-pattern target leaves the value anonymous
        "var {a:{b}={c:function(){}}}=({b:1});",
        // NOT named: a member-target assignment default stays anonymous
        "var o={};({x=function(){}}={});",
    ]);
}

// Non-trivial function bodies (child 6). Once `fxCoderOptimize`'s full
// four peephole passes are ported (branch→`END*` threading, unwind-before-
// end removal, dead-end removal, branch-to-next), a function body with
// control flow or declarations codes byte-identically. The
// `fxStatementNodeCode` store-and-pop fusion (`SET_LOCAL`/`SET_CLOSURE` +
// `POP` → `PULL_LOCAL`/`PULL_CLOSURE`) and the `mxExpressionNoValue`
// increment/compound optimization complete the non-program statement path.
#[test]
fn function_control_flow_bodies() {
    assert_identical(&[
        // loops / break / continue / return threaded to END
        "(function(){while(0)break;});", "(()=>{for(;;)break;});",
        "(function(){while(1)return;});", "(function(){for(;;)return 1;});",
        "(function(){do break;while(0);});", "(function(){label:while(1)break label;});",
        // if / return
        "(function(){if(1)return 1;});", "(function(){if(1)return 1;else return 2;});",
        "(function(a){if(a)return a;return 0;});", "(()=>{if(1)return 1;});",
        // switch / try-finally
        "(function(){switch(1){case 1:break;}});",
        "(function(){switch(1){case 1:return 1;default:return 0;}});",
        "(function(){try{return 1;}finally{2;}});",
    ]);
}

#[test]
fn function_declaring_bodies() {
    assert_identical(&[
        // var / let / const in a function body
        "(function(){var x=1;});", "(function(){var x=1;return x;});",
        "(function(){let x=1;return x;});", "(function(){const c=2;return c;});",
        "(function(){var x=1,y=2;return x+y;});", "(()=>{let a=1;return a;});",
        "(function(a){var x=a;return x;});", "(function(){{let x=1;}});",
        // the store-and-pop fusion (SET_LOCAL;POP => PULL_LOCAL)
        "(function(){var x;x=1;return x;});", "(function(a){a=a+1;return a;});",
        // the no-value increment / compound optimization
        "(function(){let x=0;x++;return x;});", "(function(){var x=0;x+=1;return x;});",
        // declarations + control flow together
        "(function(){var x=1;while(x)break;return x;});",
        "(function(a,b){if(a>b)return a;return b;});",
    ]);
}

// `catch (e)` parameter bindings (child 6). The parameter scope allocates
// the binding slot, the caught `EXCEPTION` is stored into it, then the body
// block is coded and both scopes unwind. Parameterless `catch {}` (already
// covered by `control_flow_try`) takes the single-scope path.
#[test]
fn catch_parameter_bindings() {
    assert_identical(&[
        "try{}catch(e){}", "try{1;}catch(e){e;}", "try{throw 1;}catch(e){e;}",
        "try{}catch(e){}finally{}", "try{}catch(err){throw err;}",
        "try{f();}catch(e){g(e);}", "try{}catch(e){let x=1;e;}",
        "function h(){try{return 1;}catch(e){return e;}}",
    ]);
}

// Captured closures (child 6). A variable an inner function references is
// promoted to a closure slot in its defining scope (`NEW_CLOSURE` /
// `VAR_CLOSURE`); the inner function `RETRIEVE`s the captured closures into
// its frame, accesses them via `GET_CLOSURE`, and on creation `STORE`s the
// defining scope's slot into the new function's environment. Deferred:
// arrow functions capturing `this`/`super`/`target`, and the `arguments`
// object.
#[test]
fn captured_closures() {
    assert_identical(&[
        // capture a parameter / a local
        "(function(a){return function(){return a;};});",
        "function f(){var x=1;return function(){return x;};}",
        "(function(a){return function(){return a+1;};});",
        "function g(){let y=2;return function(){return y*2;};}",
        // multiple captures, nested captures
        "(function(a,b){return function(){return a+b;};});",
        "(function(a,b,c){return function(){return a+b+c;};});",
        "(function(x){return function(){return function(){return x;};};});",
        // capture a copied local; capture + inner parameter
        "(function(a){var b=a;return function(){return b;};});",
        "(function(a){return function(b){return a+b;};});",
        // arrow closures (no this/super), mutation of a captured binding
        "(function(a){return()=>a;});", "function h(){let c=0;return()=>c;}",
        "function counter(){var n=0;return function(){n=n+1;return n;};}",
        "(function(a){return function(){a=1;return a;};});",
        // capture inside control flow
        "(function(x){if(x)return function(){return x;};return null;});",
    ]);
}

// Named function expressions (child 6). A `function g(){…}` *value* binds
// its own name `g` in a `const` slot of its scope, initialized to the
// running function (`CURRENT`), so the body can refer to itself. Deferred:
// a name captured by an inner function (a closure-slot name).
#[test]
fn named_function_expressions() {
    assert_identical(&[
        "(function g(){});", "(function g(){return g;});",
        "(function g(){return 1;});", "(function fact(n){return fact;});",
        "var f=function g(){};", "(function g(a){return a;});",
        "[function g(){}];", "(function g(){return g();});",
    ]);
}

// `for-in` / `for-of` iteration (child 6). XS seeds the iterator
// (`FOR_IN`/`FOR_OF`), caches `next`, and drives a `next()` loop inside a
// `try`/`finally` that closes the iterator (`.return()`) on
// break/continue/return/throw — reusing the same selector/alias/finalize/
// jump target machinery as `try`. Non-declaring heads (a plain reference /
// member target); declaring heads (`for (let x …)`), `using`, and
// `for await` are deferred.
#[test]
fn for_in_of_iteration() {
    assert_identical(&[
        // for-of / for-in over a reference or literal, used and empty body
        "for(x of a)x;", "for(x in a)x;", "for(x of[1,2,3])x;",
        "for(k in o)k;", "for(x of a){}", "for(x of a);", "for(x of a)f(x);",
        // break / continue / labeled break / throw crossing the iterator close
        "for(x of a)break;", "for(x of a)continue;", "for(x of a){if(x)break;}",
        "L:for(x of a)break L;", "for(x of a)throw x;",
        // member / computed targets
        "for(o.p of a)o.p;", "for(a[i] of b)a[i];",
        // nesting and inside a function (return crosses the close)
        "for(x of a)for(y of b)x;", "(function(){for(x of a)return x;});",
        "(function(){for(x of a){if(x)continue;}});",
    ]);
}

// Object concise methods and accessors (child 6). A concise method / getter
// / setter emits its (anonymous) function value with the `FUNCTION`
// creation-op, and the `NEW_PROPERTY` attribute carries the method (+
// getter/setter) bits so the runtime binds the home object and installs the
// accessor. Covers identifier and computed keys. Deferred: `super` in a
// method body.
#[test]
fn object_methods_and_accessors() {
    assert_identical(&[
        // concise methods
        "({m(){}});", "({m(a){return a;}});", "({m(a,b){return a+b;}});",
        "({m(){return 42;}});", "({m(){var x=1;return x;}});", "({m(){},n(){}});",
        // getters / setters
        "({get x(){return 1;}});", "({set x(v){}});",
        "({get x(){return 1;},set x(v){}});", "({get x(){return this;}});",
        // mixed with data properties, and computed keys
        "({a:1,m(){}});", "({m(){},a:1,get g(){return 2;}});",
        "({[k](){}});", "({get[k](){return 1;}});",
    ]);
}

// Declaring `for-in`/`for-of` heads (child 6). `for (let/const x of …)`
// binds a fresh per-iteration lexical in the loop's block scope: the scope
// header allocates the slot, `fxScopeCodeReset` (`RESET_LOCAL`) refreshes
// it each iteration, and the binding assigns via `LET_LOCAL`/`CONST_LOCAL`.
// Deferred: `for (var …)`, `for await`, and `using` heads.
#[test]
fn for_in_of_declaring_heads() {
    assert_identical(&[
        "for(let x of a)x;", "for(const x of a)x;", "for(let x in a)x;",
        "for(let x of[1,2,3])x;", "for(let x of a){}", "for(let x of a)f(x);",
        "for(let x of a)break;", "for(let k in o){k;}", "for(const c of a)c*2;",
        "for(let x of a)for(let y of b)x+y;",
        "(function(){for(let x of a)return x;});",
    ]);
}

// The `arguments` object (child 6). A function that references `arguments`
// carries a synthetic `arguments` `Var`; its scope header slots it, and the
// parameter prelude builds the object (`ARGUMENTS_SLOPPY` mapped / else
// `ARGUMENTS_STRICT`, operand = the parameter count) and stores it. A
// *mapped* `arguments` (sloppy, simple parameter list) aliases the named
// parameters, so the scoper closure-marks them (`NEW_CLOSURE`/`VAR_CLOSURE`/
// `GET_CLOSURE`); a strict `arguments` stays unmapped with local parameters.
#[test]
fn arguments_object() {
    assert_identical(&[
        "(function(){return arguments;});", "(function(){arguments[0];});",
        "(function(){var x=arguments;return x;});", "(function(){f(arguments);});",
        "(function(){return arguments[0]+arguments[1];});",
        "(function(){return arguments.length;});",
        "(function(){return function(){return arguments;};});",
        // mapped `arguments` with parameters → the parameters are closures
        "(function(a){return arguments;});", "(function(a){a;return arguments;});",
        "(function(a,b){return arguments.length;});",
        "(function(a,b,c){return arguments[0]+a;});",
        // strict `arguments` stays unmapped, so parameters remain local
        "\"use strict\";(function(){return arguments;});",
        "\"use strict\";(function(a){return arguments;});",
        "\"use strict\";(function(a,b){return arguments[0];});",
    ]);
}

// `for (var x of/in …)` (child 6). A `var` head hoists to the enclosing
// function/program scope (coded by the scope header), leaving the loop's
// block scope non-declaring, so the iteration protocol is the plain form
// and the binding takes the symbol path.
#[test]
fn for_in_of_var_head() {
    assert_identical(&[
        "for(var x of a)x;", "for(var x in a)x;", "for(var x of[1,2,3])x;",
        "for(var k in o){k;}", "for(var x of a)break;", "for(var x of a);",
        "for(var x of a)f(x);", "(function(){for(var x of a)return x;});",
    ]);
}

// `for await (… of …)` (child 6). Inside an async function the iteration
// protocol adds `AWAIT`/`THROW_STATUS` after each `next()` and `.return()`
// call (the `is_async` branch of the ported `fxForInForOfNodeCode`), now
// reachable since async functions land the async surface.
#[test]
fn for_await_of() {
    assert_identical(&[
        "(async function(){for await(x of a)x;});",
        "(async function(){for await(let x of a)x;});",
        "(async()=>{for await(x of a)x;});",
        "(async function(){for await(x of a){f(x);}});",
    ]);
}

// Object destructuring (child 6). `fxObjectBindingNodeCodeAssign`:
// `TO_INSTANCE` the value into a temporary, then read each named property
// and assign it into the target — for both destructuring assignment
// (`({a,b} = x)`) and lexical/var binding (`let {a,b} = x`). Shorthand,
// renamed (`{a: p}`), `= default` elements, and nested-value sources
// covered. Deferred (asserted): object rest (`{...r}`), computed keys
// (`{[k]: v}`), nested *patterns* (`{a: {b}}`), and array destructuring
// (which needs the iterator protocol).
#[test]
fn object_destructuring() {
    assert_identical(&[
        // assignment form (global and member-source targets)
        "({a,b}=x);", "({a}=x);", "({a,b,c}=o);", "({first,second}=pair);",
        "({a:p,b:q}=x);", "({a,b}=f());",
        // lexical / var binding form
        "let{a,b}=x;", "var{a,b}=x;", "const{a}=x;", "let{a}=obj;",
        "let{x,y,z}=p;", "let{a:p}=x;", "let{a}=x,{b}=y;",
        // `= default` elements, and inside a function body
        "({a=1}=x);", "let{a=1,b=2}=x;",
        "(function(){let{a,b}=x;return a+b;});",
    ]);
}

// Array destructuring (child 6). `fxArrayBindingNodeCodeAssign` seeds an
// iterator over the value (`FOR_OF`), pulls each element from `next()` into
// its target — skipping elision holes, collecting a `...rest` into an
// array, applying `= default`s — and closes the iterator (`.return()`) on
// early exit, reusing the selector/alias/finalize/jump `try`/`finally`
// machinery. Both destructuring assignment and lexical/var binding.
#[test]
fn array_destructuring() {
    assert_identical(&[
        // assignment form
        "[a,b]=x;", "[a]=x;", "([a,b]=f());",
        // elision holes and rest
        "[a,,b]=x;", "[,a]=x;", "[a,...r]=x;",
        // = default elements
        "[a=1]=x;",
        // lexical / var binding form
        "let[a,b]=x;", "var[a,b,c]=x;", "let[a,...r]=x;", "let[a]=x,[b]=y;",
        // inside a function body
        "(function(){let[a,b]=x;return a+b;});",
    ]);
}

// Destructuring parameters (child 6). A parameter that is an array/object
// pattern pulls its `ARGUMENT i` and binds it through the same
// `fxArrayBindingNodeCodeAssign` / `fxObjectBindingNodeCodeAssign` coders as
// standalone destructuring. Mixed with plain parameters, rest, and
// defaults; in both function expressions and arrows.
#[test]
fn destructuring_parameters() {
    assert_identical(&[
        "(function([a,b]){});", "(function({a,b}){});",
        "(function([a,b]){return a+b;});", "(function({a,b}){return a;});",
        "(function([a],b){return b;});", "(function(a,[b,c]){return b;});",
        "(function([a,...r]){return r;});", "(function({a:p}){return p;});",
        "(function([a=1]){return a;});", "(([a,b])=>a);",
    ]);
}

// Object destructuring tail (child 6): rest (`{...r}`), computed keys
// (`{[k]: v}`), and their combinations. A rest target collects the source's
// own enumerable properties minus the explicitly-bound keys via
// `COPY_OBJECT` (each bound key pushed as an exclusion argument); a computed
// key reads through `GET_PROPERTY_AT`. Nested patterns already recurse
// through the target's own assign coder.
#[test]
fn object_destructuring_rest_and_computed() {
    assert_identical(&[
        // rest
        "({...r}=x);", "let{a,...r}=x;", "({a,...rest}=o);",
        "let{p,q,...r}=x;", "let{a,b,...rest}=obj;",
        // computed keys
        "({[k]:v}=x);", "let{[k]:v}=x;", "let{[key]:val}=obj;",
        "({[a]:x,[b]:y}=o);", "({[k1]:a,[k2]:b}=o);",
    ]);
}

// `super` in object methods, and arrow capture of `this`/`super`/`target`
// (child 6). A concise method's `super.x` reads through `GET_SUPER` on the
// method's home object (already covered by the member coder's super path);
// an arrow that transitively uses `this`/`super`/`target` captures them via
// the arrow-default `RETRIEVE_TARGET`/`RETRIEVE_THIS` (and `STORE_ARROW` on
// creation). Deferred: `super` in class bodies / derived-constructor
// `super(...)` (those need the class surface).
#[test]
fn super_in_methods_and_arrows() {
    assert_identical(&[
        // super member read / call / store / delete / computed, in methods
        "({m(){return super.x;}});", "({m(){super.f();}});",
        "({m(){super.a=1;}});", "({m(){return super[k];}});",
        "({get g(){return super.v;}});", "({m(){return super.a+super.b;}});",
        "({m(){delete super.x;}});",
        // super in async / generator methods, and multiple methods
        "({async m(){return super.x;}});", "({*m(){return super.x;}});",
        "({m(){return super.x;},n(){return super.y;}});",
        // arrow capturing this / super / target (the arrow-default path)
        "({m(){return()=>super.x;}});", "({m(){return()=>this;}});",
        "({m(){return()=>this.x;}});", "({m(){return()=>super.f();}});",
        "({m(a){return()=>a+super.x;}});", "({m(){return()=>()=>this;}});",
        "(function(){return()=>this;});",
    ]);
}

// Base classes (child 6). `fxClassNodeCode` for an anonymous `class` with
// no heritage: a fresh prototype (`NULL`/`OBJECT`), the base constructor
// (`BEGIN_STRICT_BASE`/`END_BASE`), `CLASS` binding the prototype/
// constructor pair, and concise method / accessor / static members
// (`NEW_PROPERTY` with `DONT_ENUM` + method bits). The scoper reserves the
// two class temporaries (`fxClassNodeBind`). Deferred: named classes,
// `extends`, fields, private members, computed keys, and anonymous-class
// name inference.
#[test]
fn base_classes() {
    assert_identical(&[
        // empty class and a synthesized vs explicit constructor
        "(class{});", "(class{constructor(){}});",
        "(class{constructor(a){this.a=a;}});", "(class{m(a,b){return a+b;}});",
        // methods, accessors, and multiple members (no commas)
        "(class{m(){}});", "(class{m(){}n(){}});",
        "(class{get x(){return 1;}set x(v){}});",
        // static members
        "(class{static m(){}});", "(class{static m(){}i(){}});",
        "(class{static get s(){return 1;}});",
        // generator / async / super-using methods
        "(class{*g(){}});", "(class{async m(){}});",
        "(class{m(){return super.x;}});",
    ]);
}

// Derived classes (child 6). `class extends E` derives the prototype from
// `E` (`EXTEND`); the derived constructor uses `BEGIN_STRICT_DERIVED` /
// `END_DERIVED`, and `super(...)` (`fxSuperNodeCode`) invokes the parent
// constructor (`SUPER` + arguments) and installs the result as `this`
// (`SET_THIS`). Covers the synthesized default constructor
// (`constructor(...args){super(...args)}`), explicit constructors, and
// static/instance members. Deferred: fields (the instance-field-init after
// `super`) and a `@host` heritage.
#[test]
fn derived_classes() {
    assert_identical(&[
        "(class extends A{});", "(class extends A{constructor(){super();}});",
        "(class extends A{constructor(a){super(a);}});",
        "(class extends A{constructor(a,b){super(a,b);}});",
        "(class extends A{constructor(){super();this.x=1;}});",
        "(class extends A{constructor(){super();return this;}});",
        "(class extends A{m(){}});", "(class extends B{static m(){}});",
        "(class extends(f()){});", "(class extends A{m(){return super.x;}});",
    ]);
}

// Cross-construct integration (child 6). Real-world programs that combine
// many of the ported strata at once — functions/closures + destructuring +
// generators/async + classes/`super` + control flow, deeply nested. These
// stress the *interactions* between slices (slot numbering carried across a
// closure through a destructured parameter, a `super` call inside a
// destructuring method, a `for-await` over a defaulted rest parameter, …)
// that per-construct tests do not, and are the strongest guard against a
// regression in one stratum silently shifting another's bytes.
#[test]
fn cross_construct_integration() {
    assert_identical(&[
        // functions + closures + destructuring
        "function f(a,{b,c}){return()=>a+b+c;}",
        "(function(x){let[a,b]=x;return function(){return a+b;};});",
        "var g=(...args)=>args.map(x=>x*2);",
        // control flow + generators + async
        "function*gen(a){let s=0;for(const x of a){yield s+=x;}}",
        "async function af(x){try{return await x;}catch(e){return e;}}",
        // classes + methods + super + destructuring params
        "(class extends Base{m({a,b}){return super.m(a)+b;}});",
        "(class{constructor(...a){this.a=a;}static of(...a){return new this(...a);}});",
        // deeply nested combinations
        "function outer(){let c=0;return{inc(){return++c;},get val(){return c;}};}",
        "for(const{x,y}of pts){f(x,y);}",
        "const h=async({a=1,...rest})=>{for await(let x of a){rest[x]=x;}return rest;};",
        "function sw(n){L:for(;;){switch(n){case 1:break L;default:n--;}}return n;}",
        "(function(){var o={a:1,m(){return this.a;},['k'+1](){return 2;}};return o;});",
    ]);
}

// Static initializer blocks (child 6). A `static { … }` block folds into
// the same `constructorInit` field-init function as the static data fields
// (in source order), running its statements directly (no `this` /
// `NEW_PROPERTY`) with `this` bound to the constructor. Covers blocks mixed
// with static fields, multiple blocks, `super`, control flow, and
// interleaving with methods. Deferred: a block with its own lexical
// declarations — XS RESERVEs those slots in the constructorInit function
// via its `scopeMaximum`; the inline-synthesized field-init function here
// has no such precomputed frame count yet (loud fold, never mis-emitted).
#[test]
fn static_blocks() {
    assert_identical(&[
        "(class{static{}});", "(class{static{x;}});",
        "(class{static{a;}static{b;}});", "(class{static{this.x=1;}});",
        "(class{static x=1;static{y;}});",
        "(class{static x=1;static y=2;static{z;}});",
        "(class extends A{static{super.x;}});",
        "(class{m(){}static{this.n=1;}});", "(class{static{for(;;)break;}});",
    ]);
}

#[test]
fn wide_operands_and_branch_widths() {
    // Force INTEGER width transitions and a long branch (BRANCH_2) by
    // padding the then-arm with many statements.
    let long_then = format!("if(1){{{}}}else 2;", "3;".repeat(120));
    assert_identical(&[
        "127", "128", "255", "256", "32767", "32768", "-128", "-129",
        "-32768", "-32769",
        long_then.as_str(),
    ]);
}

#[test]
fn function_default_parameters() {
    assert_identical(&[
        "((a=1)=>a);", "((a,b=2)=>a+b);", "(function(a=1){return a;});",
        "(function(a,b=2){return a+b;});", "(function(a=1,b=2){return a+b;});",
        "((a=1,b=a)=>a+b);", "(function(x,y=x+1){return y;});",
    ]);
}

#[test]
fn function_rest_parameters() {
    assert_identical(&[
        "(function(...a){return a;});", "(function(a,...b){return b;});",
        "((...xs)=>xs);", "((a,b,...rest)=>rest);",
        "(function(x,...ys){return ys;});",
    ]);
}

#[test]
fn object_property_name_inference() {
    assert_identical(&[
        "({f:function(){}});", "({g:()=>1});", "({f:function(){},g:()=>2});",
        "({[k]:function(){}});", "({a:1,f:function(){}});",
        // named values keep their own name (no inference flag)
        "({f:function named(){}});",
        // non-function values unaffected
        "({a:1,b:2});",
    ]);
}

#[test]
fn object_shorthand() {
    assert_identical(&[
        "({x});", "({x,y});", "({a,b,c});",
        "let x=1;({x});", "let a=1,b=2;({a,b});",
        "({x,y:2});", "({a:1,b});",
    ]);
}

#[test]
fn object_spread() {
    assert_identical(&[
        "({...a});", "({...a,...b});", "({x:1,...a});", "({...a,x:1});",
        "({a:1,...b,c:3});", "let o={x:1};({...o});",
    ]);
}

#[test]
fn array_spread() {
    assert_identical(&[
        "[...a];", "[1,...a];", "[...a,2];", "[1,...a,2];",
        "[...a,...b];", "[...a,,b];", "let a=[1];[...a,2];",
    ]);
}

#[test]
fn call_new_spread() {
    assert_identical(&[
        "f(...a);", "f(1,...a);", "f(...a,2);", "f(...a,...b);",
        "f(1,...a,2);", "new X(...a);", "new X(1,...a);",
        "a.m(...b);", "let a=[1];f(...a);",
    ]);
}

#[test]
fn object_proto() {
    assert_identical(&[
        "({__proto__:null});", "({__proto__:x});", "({__proto__:x,a:1});",
        "({a:1,__proto__:x});", "let x={};({__proto__:x});",
        // a shorthand or computed __proto__ is a NORMAL property (not the setter)
        "({['__proto__']:1});",
    ]);
}

#[test]
fn generator_functions() {
    assert_identical(&[
        "(function*(){});", "(function*(){yield 1;});", "(function*(){yield;});",
        "(function*(){yield 1;yield 2;});", "(function*(a){yield a;});",
        "(function*(){return 1;});", "(function*(){let x=yield 1;return x;});",
        "function*g(){yield 1;}",
    ]);
}

#[test]
fn async_functions() {
    assert_identical(&[
        "(async function(){});", "(async function(){await 1;});",
        "(async function(){return await 1;});", "(async function(a){await a;});",
        "(async ()=>await 1);", "(async ()=>{await 1;await 2;});",
        "async function f(){await 1;}",
        "(async function(){let x=await 1;return x;});",
    ]);
}

#[test]
fn async_generators() {
    assert_identical(&[
        "(async function*(){});", "(async function*(){yield 1;});",
        "(async function*(){yield await 1;});", "(async function*(){await 1;yield 2;});",
        "async function*g(){yield 1;}", "(async function*(a){yield a;});",
    ]);
}

#[test]
fn yield_star_delegate() {
    assert_identical(&[
        "(function*(){yield* a;});", "(function*(){yield* [1,2];});",
        "(function*(){yield 1;yield* a;yield 2;});",
        "(async function*(){yield* a;});",
        "function*g(){yield* h();}",
    ]);
}

#[test]
fn direct_eval() {
    assert_identical(&[
        "eval(x);", "eval(1);", "eval(1,2);", "eval();",
        "eval(a,b,c);", "eval(x+1);",
        // eval spread + eval as sub-expression
        "eval(...a);", "eval(1,...a);", "y=eval(x);",
        // NOT direct eval: member call / shadowed-by-property
        "a.eval(x);", "o.eval(1,2);",
        // eval-poisoned scope with declarations (program/block level) still matches
        "let y=1;eval(y);", "{let z=1;eval(z);}", "var v=1;eval(v);",
    ]);
}

#[test]
fn named_classes() {
    assert_identical(&[
        "(class C{});", "class C{}", "(class C{m(){}});",
        "(class C{m(){}n(){}});", "(class C{static s(){}});",
        "(class C{get x(){}set x(v){}});", "(class C{constructor(){}});",
        "let K=class C{};", "(class C{*g(){}async a(){}});",
        // class body references its own name (USE_CLOSURE)
        "(class C{m(){return C;}});", "(class C{static s(){return C;}});",
    ]);
}

#[test]
fn class_computed_method_keys() {
    assert_identical(&[
        "(class{[k](){}});", "(class{static [k](){}});", "(class{[k+1](){}});",
        "(class{[k](){}m(){}});", "(class{get [k](){}});", "(class{*[k](){}});",
        "(class C{[k](){}});",
    ]);
}

#[test]
fn anonymous_class_name_inference() {
    assert_identical(&[
        "let C=class{};", "const D=class{};", "var E=class{};",
        "x=class{};", "let C=class{m(){}};", "let C=class extends B{};",
        // a named class keeps its own name (no inference)
        "let K=class C{};",
    ]);
}

#[test]
fn class_static_fields() {
    assert_identical(&[
        "(class{static x=1;});", "(class{static x=1;static y=2;});",
        "(class{static x;});", "(class{static m(){}static x=1;});",
        "(class C{static x=1;});", "(class{static x=1+2;});",
        "(class{static f=function(){};});",
    ]);
}

#[test]
fn class_instance_fields() {
    assert_identical(&[
        "(class{x=1;});", "(class{x;});", "(class{x=1;y=2;});",
        "(class C{x=1;});", "(class{x=1+2;});", "(class{x=this;});",
        "(class{f=function(){};});", "(class{m(){}x=1;});",
        "(class{x=1;m(){}y=2;});", "class C{x=1;}",
        // instance and static fields interleaved
        "(class{static a=1;b=2;static c=3;d=4;});",
        "(class{x=1;static y=2;});",
    ]);
}

#[test]
fn class_instance_fields_derived() {
    assert_identical(&[
        "(class extends Object{x=1;});", "(class C extends Object{x=1;});",
        "(class extends Object{x=1;y=2;});",
        "(class extends Object{constructor(){super();}x=1;});",
        "(class extends Object{constructor(a){super(a);}x=a;});",
        "(class extends Object{m(){}x=1;});",
        "(class extends Object{f=function(){};});",
        "(class extends Object{static s=1;x=2;});",
        "(class extends Object{x=this;y=1;});",
        "(class C extends Object{constructor(){super();this.z=3;}x=1;});",
    ]);
}

// Computed-key fields (`[e] = v`): the class coder evaluates the key once at
// class-definition time (`AT` + `CONST_CLOSURE` into the class-scope
// `atAccess`); the field-init function then captures that closure as a
// use-closure alias — the keystone scope-aware field function — and reads it
// back (`RETRIEVE` at entry, `GET_CLOSURE` + `NEW_PROPERTY_AT` per field).
#[test]
fn class_computed_fields() {
    assert_identical(&[
        "(class{[k]=1;});", "(class{[k]=1;[j]=2;});", "(class{[k+1]=2;});",
        "(class{[k]=this;});", "(class{[k];});",
        // interleaved with a plain field, a method, and a static field
        "(class{x=1;[k]=2;});", "(class{[k]=1;m(){}});", "(class{[k]=1;static y=2;});",
        // named / derived / static computed key
        "(class C{[k]=1;});", "(class extends A{[k]=1;});", "(class{static [k]=1;});",
    ]);
}

// Private data fields (`#x = v`): the class coder binds the private brand
// into the class-scope `symbolAccess` closure (`CONST_CLOSURE`); the field
// function captures it and installs the private on `this` (`NEW_PRIVATE`).
#[test]
fn class_private_fields() {
    assert_identical(&[
        "(class{#x=1;});", "(class{#x;});", "(class{#x=1;#y=2;});",
        "(class{#x=this;});", "(class{#x=function(){};});",
        // interleaved with public data / method / static members
        "(class{x=1;#y=2;});", "(class{#x=1;m(){}});", "(class{#x=1;static #y=2;});",
        "(class C{#x=1;});", "(class extends A{#x=1;constructor(){super();}});",
        "(class{static #x=1;});",
    ]);
}

// Private methods / accessors (`#m(){}`, `get #g(){}`, `set #s(v){}`): the
// class coder stores the method value into the class-scope `valueAccess`
// closure (`CONST_CLOSURE`), and the field function reads it (`GET_CLOSURE`)
// to install the private as a method/accessor (`NEW_PRIVATE` with the
// method/getter/setter attribute). `valueAccess` precedes `symbolAccess` in
// the field function's alias order, matching `fxFieldNodeCode`.
#[test]
fn class_private_methods() {
    assert_identical(&[
        "(class{#m(){}});", "(class{#m(){}#n(){}});", "(class{get #g(){}});",
        "(class{set #s(v){}});", "(class{#m(){}#x=1;});", "(class{static #m(){}});",
        "(class{#m(){}m(){}});",
    ]);
}

// Cross-construct: computed keys + private members + a plain field in one
// class, on base and derived-`super` shapes — the full class-tail surface in
// a single init function, exercising the mixed alias/store ordering.
#[test]
fn class_tail_mixed() {
    assert_identical(&[
        "(class{x=1;#y=2;[z]=3;});",
        "(class{static a=1;#b=2;[c]=3;m(){}});",
        "(class extends A{#x=1;[k]=2;constructor(){super();}});",
        "(class C extends A{a=1;#b=2;[c]=3;#m(){}static #s=9;});",
    ]);
}

// Private member READS/WRITES (`this.#x`, `obj.#m()`) + the `#x in obj`
// brand check. A private reference resolves its `#name` through the same
// class-scope `symbolAccess` closure the declaration slice installs (a
// use-closure alias in the accessing method's frame); the coder emits the
// `*_PRIVATE` family: `GET_PRIVATE` for a read (`fxPrivateMemberNodeCode`),
// `SET_PRIVATE` for a write (`fxPrivateMemberNodeCodeAssign`), a `DUB` +
// `GET_PRIVATE` receiver for a private method call
// (`fxPrivateMemberNodeCodeThis`), and `HAS_PRIVATE` for `#x in obj`
// (`fxPrivateIdentifierNodeCode`). Compound assignment / increment on a
// private member reuse the `codeThis` + `codeAssign` pair.
#[test]
fn class_private_member_reads() {
    assert_identical(&[
        // instance field read / write through `this.#x`
        "(class{#x=1;get(){return this.#x;}});",
        "(class{#x=1;set(v){this.#x=v;}});",
        "(class{#x=0;bump(){this.#x=this.#x+1;}});",
        // private method call `this.#m()` (kept out of tail position — a
        // tail call's `RUN_TAIL` is an orthogonal sibling fold)
        "(class{#m(){return 1;}run(){this.#m();}});",
        "(class{#m(a){return a;}run(){return 1+this.#m(2);}});",
        // private getter / setter access
        "(class{get #g(){return 7;}read(){return this.#g;}});",
        "(class{set #s(v){}write(v){this.#s=v;}});",
        // brand check `#x in obj`
        "(class{#x=1;has(o){return #x in o;}});",
        "(class{#m(){}has(o){return #m in o;}});",
        // compound assignment and increment on a private member
        "(class{#x=1;add(){this.#x+=2;}});",
        "(class{#x=1;inc(){this.#x++;}});",
        "(class{#x=1;pre(){return ++this.#x;}});",
        "(class{#x=1;or(){this.#x||=5;}});",
        // a private read on another instance of the same class
        "(class{#x=1;eq(o){return this.#x===o.#x;}});",
        // static private member accessed from a static method
        "(class{static #s=1;static read(){return this.#s;}});",
        "(class{static #m(){return 4;}static run(){this.#m();}});",
        // private access nested in an inner arrow (use-closure through two frames)
        "(class{#x=1;f(){return 1+(()=>this.#x)();}});",
        // named/derived class shapes carrying private reads
        "(class C{#x=1;get(){return this.#x;}});",
        "(class extends A{#x=1;constructor(){super();}get(){return this.#x;}});",
    ]);
}

// A private accessor **pair** (`get #x` / `set #x`) shares ONE brand
// closure across both members (XS's `fxScopeLookup` resolves both
// `symbolAccess` nodes — same symbol pointer — to the first class-scope
// declare, so the field-init function captures the brand once, not twice).
// Class β / accessor-pair brand double-capture (stage-5 fix3). The
// synthesized field-init function must `RESERVE`/`RETRIEVE`/`STORE` one
// shared brand slot; a naive per-member capture emits an extra `STORE_1`.
#[test]
fn class_private_accessor_pair_shares_brand() {
    assert_identical(&[
        // the minimal get/set pair — one shared brand, two value closures
        "(class{get #x(){return 1;}set #x(v){}});",
        // pair plus a body that reads/writes it (exercises get_private/set_private)
        "(class{get #x(){return this._x;}set #x(v){this._x=v;}read(){return this.#x;}write(v){this.#x=v;}});",
        // getter-only and setter-only stay single-brand (no pair to dedup)
        "(class{get #g(){return 7;}});",
        "(class{set #s(v){}});",
        // two independent private names, each a full get/set pair
        "(class{get #a(){return 1;}set #a(v){}get #b(){return 2;}set #b(v){}});",
        // an accessor pair interleaved with a private data field and a private method
        "(class{#d=1;get #x(){return 1;}set #x(v){}#m(){return 2;}});",
        // named / static-mixed shapes carrying an instance accessor pair
        "(class C{get #x(){return 1;}set #x(v){}});",
        "(class{static #s=1;get #x(){return 1;}set #x(v){}});",
    ]);
}

// A class field initializer whose VALUE is a function/arrow carries
// `mxFieldFlag` (copied from the field-parse `parser->flags`), so its
// function value opens with `BEGIN_STRICT_FIELD` rather than a plain
// `BEGIN_STRICT` (XS's `fxFunctionNodeCode` field branch). Instance,
// static, and private field slots, base and derived.
#[test]
fn class_field_value_functions() {
    assert_identical(&[
        // arrow field values (the `mxFieldFlag | mxArrowFlag` flavor)
        "(class{f=()=>1;});", "(class{f=()=>this;});", "(class{f=(a)=>a;});",
        "(class{static f=()=>1;});", "(class{#f=()=>1;});",
        "(class{static #f=()=>this;});",
        // async arrow field value
        "(class{f=async()=>1;});", "(class{f=async(a)=>await a;});",
        // arrow field reading the instance via a captured `this`
        "(class{x=1;f=()=>this.x;});",
        // named/derived shapes
        "(class C{f=()=>1;});", "(class extends A{f=()=>this;constructor(){super();}});",
        // interleaved with a plain field and a method
        "(class{a=1;f=()=>2;m(){}});",
    ]);
}

// `new.target` (`fxValueNodeCode` for a `Target` node → the single
// `XS_CODE_TARGET` byte). Read in a construct it is the target constructor,
// in a plain call `undefined`; the coder emits the same byte for both (the
// runtime distinguishes). Each fixture runs a function declaration whose
// body reads `new.target` on both call shapes.
#[test]
fn new_target() {
    assert_identical(&[
        // inside a construct call is the constructor; a plain call is undefined
        "var t; function F(){ t = new.target; } new F(); t === F;",
        "var t; function F(){ t = new.target; } new F(); typeof t;",
        "function F(){ return typeof new.target; } var r = new F(); typeof r;",
        "var t; function F(){ t = new.target; } F(); typeof t;",
        "var t; function F(){ t = new.target; } F(); t === undefined;",
        "function F(){ return new.target === undefined; } F();",
        // the factory guard idiom + the ternary on new.target
        "function F(){ if (new.target === undefined) { return 99; } this.x = 1; } F();",
        "function F(){ return new.target ? 1 : 2; } F();",
        "function F(){ return new.target === F; } new F();",
        // a closure-captured constructor still sees new.target
        "var t; function make(){ function G(){ t = new.target; } return G; } var g = make(); new g(); t === g;",
        // per-frame: a construct then a plain call
        "var t; function F(){ t = new.target; } new F(); F(); t === undefined;",
    ]);
}

// Optional chaining (`fxChainNodeCode` + `fxOptionNodeCode`): the `Chain`
// wrapper installs a short-circuit target and each `?.` link
// `BRANCH_CHAIN`es to it when its base is nullish, leaving the chain's value
// `undefined`. Member and computed-member links, single and nested.
#[test]
fn optional_chaining() {
    assert_identical(&[
        "var o = { a: 1 }; o?.a",
        "var o2 = null; o2?.a",
        "var o3 = { a: { b: 7 } }; o3?.a?.b",
        // nullish base short-circuits the rest of the chain
        "var o = null; o?.a?.b",
        "var o = { a: null }; o?.a?.b",
        // computed-member optional link
        "var o = { a: 1 }; o?.[\"a\"]",
        "var o = null; o?.[0]",
        // an optional link mid-chain, then a plain member
        "var o = { a: { b: 3 } }; o?.a.b",
    ]);
}

// A `for (let …)` head declares a per-iteration binding, so the loop's
// test/update re-enters through `fxScopeCodeRefresh` (a `REFRESH_LOCAL` per
// declared slot) — the previously-folded declaring-scope path.
#[test]
fn for_let_declaring_scope() {
    assert_identical(&[
        "for (let i = 0; i < 3; i = i + 1) {} 9",
        "let c = 0; for (let i = 0; i < 5; i = i + 1) { c = c + i } c",
        "for (let i = 0; i < 2; i = i + 1);",
        "for (let i = 0, j = 3; i < j; i = i + 1) {}",
    ]);
}

// A nested function declaration binds a `Define` in its enclosing function
// body's scope (`fxScopeCodingBlock` slots it, `fxScopeCodeDefineNodes`
// assigns the function value) — the previously-folded function-declaration
// declaring path.
#[test]
fn nested_function_declaration() {
    assert_identical(&[
        "function outer(){ function inner(){ return 1; } return inner(); } outer();",
        "function make(){ function G(){ return 7; } return G; } make()();",
        "function f(){ function g(){} function h(){} return 0; } f();",
    ]);
}

// Name inference stops at a non-identifier assignment target: `o.m =
// function(){}` (a member LHS) leaves the value anonymous (no `NAME`),
// whereas a bare-identifier assignment names it. Both are pinned.
#[test]
fn anonymous_function_member_target_no_name() {
    assert_identical(&[
        "var o = {}; o.m = function(){};",
        "var o = {}; o.m = function(){}; o.m();",
        "var o = {}; o[\"k\"] = function(){};",
        "function F(){} F.valueOf = function(){ return 1; }; 1 + F;",
        // a bare-identifier assignment still infers the name
        "var g; g = function(){}; g.name;",
    ]);
}

// ============================ module goal ============================
//
// The Module goal (stage-5 modules child): `ironhorse_compile::compile_module`
// must equal `xs_oracle::compile_module(src).bytecode` byte for byte.
// The oracle module entry parses as a Module and returns `codeBuffer`
// WITHOUT running (a module cannot `fxRunScript` without a linker), so —
// unlike the script fixtures above — a module fixture need not be
// runnable; it need only compile.

/// `assert_identical` for the Module goal (compile-only ground truth).
fn assert_identical_module(corpus: &[&str]) {
    let mut fails: Vec<String> = Vec::new();
    for &src in corpus {
        let want = match xs_oracle::compile_module(src) {
            Some(o) if o.compiled => o.bytecode,
            Some(o) => {
                fails.push(format!("{src:?}: oracle rejected the module ({})", o.error));
                continue;
            }
            None => {
                fails.push(format!("{src:?}: oracle machine failed"));
                continue;
            }
        };
        match compile_module(src) {
            Ok(got) if got == want => {}
            Ok(got) => {
                let wd = disasm(&want);
                let gd = disasm(&got);
                let mut diff = String::new();
                let n = wd.len().max(gd.len());
                for i in 0..n {
                    let w = wd.get(i).map(String::as_str).unwrap_or("--");
                    let g = gd.get(i).map(String::as_str).unwrap_or("--");
                    let mark = if w == g { "  " } else { "!!" };
                    diff.push_str(&format!("    {mark} want[{w}]  got[{g}]\n"));
                }
                fails.push(format!(
                    "{src:?} MISMATCH\n  want {}\n  got  {}\n{}",
                    hex(&want),
                    hex(&got),
                    diff
                ));
            }
            Err(e) => fails.push(format!("{src:?}: compile_module error {e:?} (want {})", hex(&want))),
        }
    }
    if !fails.is_empty() {
        panic!("{} module divergence(s):\n{}", fails.len(), fails.join("\n"));
    }
}

#[test]
fn module_imports() {
    assert_identical_module(&[
        // default / named / namespace imports and combinations
        "import x from \"m\";",
        "import { a } from \"m\";",
        "import { a as b } from \"m\";",
        "import { a, b, c } from \"m\";",
        "import * as ns from \"m\";",
        "import def, { a, b as c } from \"m\";",
        "import def, * as ns from \"m\";",
        "import \"side-effect\";",
        // live-binding access
        "import { f } from \"m\"; f();",
        "import def from \"m\"; def.method();",
    ]);
}

#[test]
fn module_exports() {
    assert_identical_module(&[
        // export declarations
        "export const x = 1;",
        "export let y = 2;",
        "export var v = 5;",
        "export const a = 1, b = 2, c = 3;",
        // export bindings (list forms), including the hoisted-before-decl case
        "let x = 1; export { x };",
        "let x = 1; export { x as y };",
        "export { a, b }; let a = 1; let b = 2;",
        // export function / class declarations
        "export function f() {}",
        "export class C {}",
        "export function a() {} export function b() {}",
        // export as the default name
        "const x = 1; export { x as default };",
    ]);
}

// Class α — a plain (literal-keyed) instance data field whose initializer
// captures an outer binding. XS moves the initializers into a real
// `instanceInit` `mxFieldFlag` function, so a captured outer binding is
// promoted to a **closure** (`NEW_CLOSURE`/`CONST_CLOSURE`) and read inside
// the field function via a use-closure alias (`RESERVE`/`RETRIEVE`/
// `GET_CLOSURE`); an uncaptured field stays a plain local. These fixtures pin
// the closure-vs-local classification (opcodes 228↔230 family) the scoper's
// field-init function scope reproduces.
#[test]
fn class_field_init_closure_capture() {
    assert_identical(&[
        // the representative: an outer `const` captured by a data field
        "const fn = function() {}; class C { a; b = 42; c = fn }",
        // a single captured field, no siblings
        "const fn = function() {}; class C { c = fn }",
        // capture interleaved with public methods (still plain data fields)
        "const fn = function() {}; class C { a; b = 42; c = fn; m() { return 42; } }",
        "const fn = function() {}; class C { foo = 1; m() {} a; b = 42; c = fn; n() {} bar = 2; }",
        // a captured `var`
        "var x = 1; class C { p = x; }",
        // no capture: fields stay plain locals (unchanged behavior)
        "class C { a; b = 42; }",
        "class C { a; }",
        // derived class: the field-init function still promotes the capture
        "class Base {} class C extends Base { a; b = 1; }",
        "var x = 1; class Base {} class C extends Base { a; p = x; }",
        // two captured outer bindings, in field order
        "const f = function() {}; const g = function() {}; class C { a = f; b = g; }",
    ]);
}

// Classes β + ε — computed-key / private / static field initializers bound
// inside a real `instanceInit` / `constructorInit` **function scope** (XS's
// `mxFieldFlag` field function). A field value's inner function/class captures
// outer bindings AND private brands through the field function, not the class
// scope: a nested class's private slots no longer leak into the enclosing
// frame (the `RESERVE` count), a `this.#x` read in an initializer resolves to
// the field function's captured retrieve slot (`GET_PRIVATE`), and the field
// value temporaries land at the counted frame depth. These fixtures pin the
// closed shapes (nested-class private `RESERVE`, field-init brand read,
// init-value temp depth, static-field-init, shared accessor-pair brand).
#[test]
fn class_field_init_function_scope() {
    assert_identical(&[
        // nested-class private-member RESERVE: a nested class in a field value
        // keeps its own private/temporary slots in the field function frame
        "class C { #outer = 1; B = class { method(o){ return o.#outer } }; }",
        "class C { #outer=1; B = class { #inner = 2; method(o){ return o.#outer } }; }",
        // init-value temporary depth: two computed keys + peak temp
        "var x = 0; class C { [x++] = x++; [x++] = x++; }",
        // field-initializer private-brand read (GET_PRIVATE via the retrieve slot)
        "class C { #x = 1; g = this.#x; }",
        "class C { #a = 1; #b = 2; sum = this.#a + this.#b; }",
        // a private method value read in an initializer
        "class C { #m(){return 7} v = this.#m(); }",
        // shared getter/setter brand (one slot, not two)
        "class C { get #x(){return 1} set #x(v){} y = this.#x; }",
        // the static twin (constructorInit): private-brand read + capture
        "class C { static #x = 1; static g = C.#x; }",
        "class C { static #s = 1; static m(){ return C.#s } }",
        "let y=5; class C { static a = y; static b = y+1; }",
        "class C { static get #p(){return 1} static set #p(v){} static q = C.#p; }",
        // a simple static block runs inside constructorInit
        "class C { static { this.p = 1; } }",
        // the cross-construct mix on a derived class
        "class Base {} class C extends Base { #x = 1; g = this.#x; }",
        "const f=()=>0; class C { #x = 1; static #s = 2; g = this.#x; static h = C.#s; k = f; }",
    ]);
}

// Class γ — a class-field initializer containing a direct `eval(...)`. XS's
// field-init function (`instanceInit` / `constructorInit`) is reached by the
// scope's `mxEvalFlag` (the hoist-time poison walk now reaches the field-init
// scope sibling 1 creates at hoist), so `fxScopeCodingParams` opens the field
// function body with the strict eval prelude (`undefined; with; pop`) and
// `fxScopeCodeStore` captures the whole enclosing class frame (store-all). These
// pin the plain, derived-with-super, static, and private-adjacent shapes.
#[test]
fn class_field_init_direct_eval() {
    assert_identical(&[
        // plain instance field
        "class C { x = eval('1'); }",
        // a field capturing an outer binding the eval can read
        "class C { a; b = eval('a'); }",
        // derived class: the eval sees `super`
        "class A {} class C extends A { x = eval('super.x'); }",
        // static field (constructorInit) eval reading `this`
        "class C { static h = eval('this.g'); }",
        // private-adjacent: a `this.#m` visible to the direct eval
        "class C { #m = 44; v = eval('this.#m'); }",
        // static private brand adjacent to a static eval field
        "class C { static #s = 1; static q = eval('C'); }",
    ]);
}

// A captured named-function-expression self-name — the `tco-call-args`
// fold (stage-5 fix4 3/4, slice 3). When a nested function captures the
// enclosing function's own name (`function f(){ g=()=>f; }`), XS's
// `fxScopeCodingBlock` promotes the name `Define` to a closure slot
// (`NEW_CLOSURE`) and binds `CURRENT` through `CONST_CLOSURE_1`, so the
// nested closure's capture resolves. Ironhorse previously asserted-out
// ("captured function name deferred") on this shape.
#[test]
fn captured_function_self_name() {
    assert_identical(&[
        // a nested function reads the enclosing function's own name
        "(function f(n) { function g() { return f; } return g()(n); });",
        // a nested arrow captures the self-name
        "var probe; var func = function f() { probe = function() { return f; }; };",
        // tail-call through a nested getter of the self-name (tco-call-args)
        "'use strict'; (function f(n) { if (n === 0) return; function getF() { return f; } return getF()(n - 1); });",
        // strict + sloppy `scope-name-var` shapes
        "var func = function f() { var probe = function() { return f; }; return probe; };",
    ]);
}

// Numeric accessor/property keys — `fxPropertyName`'s `fxNumberToIndex`
// classification (stage-5 fix4 3/4). A numeric key that is a canonical
// array index codes through the index path (`NUMBER`/`INTEGER` + `AT` +
// `NEW_PROPERTY_AT`); a NON-index numeric key (`.1`, `0.0000001`, and any
// value at/above 2^32-1) canonicalizes to its `fxNumberToString` symbol
// and codes by name (`NEW_PROPERTY`). Ironhorse previously always took the
// index path, coding a non-index key 16 bytes longer.
#[test]
fn class_accessor_numeric_key_canonicalization() {
    assert_identical(&[
        // leading-decimal accessor key: `.1` → symbol "0.1"
        "class C { get .1() { return 1; } set .1(v) {} }",
        "class C { static get .1() { return 1; } static set .1(v) {} }",
        // non-canonical numeric accessor key: `0.0000001` → symbol "1e-7"
        "class C { get 0.0000001() { return 1; } }",
        "class C { static get 0.0000001() { return 1; } }",
        // class instance/static data members with a non-index numeric key
        "class C { .1() {} }",
        "class C { 0.0000001() {} }",
        // object-literal numeric keys, both branches
        "({ .1: 'a', 0.0000001: 'b', 0: 'i', 1: 'j' })",
        "({ get .1() { return 1; }, set .1(v) {} })",
    ]);
}

// Numeric property key at the array-index boundary — `fxNumberToIndex` +
// `fxPushIndexNode` (stage-5 fix4 3/4, slice 4). A key at/above the
// 2^32-1 sentinel is NOT an index (→ `fxNumberToString` symbol); an
// in-range key whose `(txIndex)` value overflows a signed int
// (`4294967294`, `2147483648`) is still an index but must code as a
// `NUMBER` node (`fxPushIndexNode`'s `(txInteger)value < 0` arm), NOT
// wrap negative through an `INTEGER` node.
#[test]
fn numeric_property_key_index_boundary() {
    assert_identical(&[
        "({ 4294967294: 1 })", // index, > i32::MAX → NUMBER node
        "({ 4294967295: 1 })", // == sentinel → NOT an index → symbol
        "({ 4294967296: 1 })", // > sentinel → symbol
        "({ 2147483648: 1 })", // 2^31, index, wraps i32 → NUMBER node
        "({ 2147483647: 1 })", // i32::MAX, index → INTEGER node
        "({ 4294967294() {} })", // same boundary as a method key
        "({ 2147483648() {} })",
    ]);
}

// NamedEvaluation of an anonymous class WITH a heritage — the inferred
// name binds the class **constructor**, not the heritage expression
// (stage-5 fix4 3/4, Class α). `code_class` codes the heritage first; a
// heritage `function(){}` is itself a CONSTRUCTOR_FUNCTION that would
// consume the staged pending name, so the name must be held across the
// heritage evaluation and restored for the constructor. Covers the
// `strict-mode/arguments-callee` residual.
#[test]
fn named_class_with_heritage_names_constructor() {
    assert_identical(&[
        "var D = class extends function() {} {};",
        "var D = class extends function() { arguments.callee; } {};",
        "let E = class extends function() {} {};",
        "const F = class extends Object {};",
        "var G = class extends function() {} { m() {} };",
        // an assignment target infers the same way
        "var H; H = class extends function() {} {};",
        // a named class keeps its own name; heritage stays anonymous
        "var I = class Named extends function() {} {};",
    ]);
}

#[test]
fn module_default_and_reexport() {
    assert_identical_module(&[
        // default exports: expression, named/anonymous function, class
        "export default 42;",
        "export default [1, 2, 3];",
        "export default function foo() {}",
        "export default function () {}",
        "export default class {}",
        "export default class C {}",
        "const x = 1; export default x;",
        // re-export forms
        "export { a } from \"m\";",
        "export { a as b } from \"m\";",
        "export * from \"m\";",
        "export * as ns from \"m\";",
        "export { default } from \"m\";",
        "export { a as default } from \"m\";",
        // live-binding access across exported functions
        "let n = 0; export function inc() { n = n + 1; } export function val() { return n; }",
    ]);
}

// Arrow **receiver capture under direct `eval`** — the fix5 arrow scope-slot
// fold. `fxScopeCodeRetrieve`/`fxScopeCodeStore` emit
// `RETRIEVE_TARGET`/`RETRIEVE_THIS` (into the body) and `STORE_ARROW` (in the
// enclosing frame) when the scope's node is an arrow AND either it
// transitively uses `this`/`super`/`target` (`mxDefaultFlag`) OR its own
// scope is `eval`-poisoned (`mxEvalFlag`). The eval half is the divergence
// this fixture locks: an arrow with a body direct `eval` (a distinct lexical
// environment from a `let`, or a destructuring/rest parameter var
// environment) captures the receiver even when nothing lexically names
// `this`. Pre-fix ironhorse keyed only on `arrow_default` and emitted the shorter
// stream (missing the retrieve triple + store_arrow).
#[test]
fn arrow_receiver_capture_under_eval() {
    assert_identical(&[
        // body lexical env distinct from the var env (a `let`) + direct eval
        "var a = () => { let x; eval('var x;'); };",
        // plain arrow body direct eval, no lexical declaration
        "var a = () => eval('1');",
        // destructuring parameter (a separate parameter var environment) + eval
        "var f = ([a]) => { eval('a'); };",
        // rest parameter var environment + eval
        "var f = (...b) => { eval('b'); };",
        // element-then-rest destructuring param + eval
        "var f = ([a], ...b) => { eval('a'); };",
    ]);
}

// The **enclosing-function synthetic capture-closure** fold (fix6). When an
// arrow that contains a direct `eval` (which may reach `this`/`arguments`) is
// created inside a non-arrow function, `fxArrowExpression` bubbles the inner
// `mxEvalFlag` out onto the enclosing function node. That function then
// reserves a *materialization-free* synthetic `arguments` closure
// (`RESERVE` + `NEW_CLOSURE` + a `with`-publish `STORE_1`, plus the closing
// two-`WITHOUT` teardown) so the arrow's `STORE_ARROW`/`RETRIEVE` capture is
// reachable through the direct eval's scope — but *no* `ARGUMENTS_SLOPPY`
// materialization, because the enclosing node never gains `mxArgumentsFlag`.
// (`expressions/arrow-function/arrow/binding-tests-3.js`.)
#[test]
fn arrow_eval_enclosing_capture_closure() {
    assert_identical(&[
        // the closed shape: arrow + direct eval capturing enclosing `this`,
        // enclosing function eval-only ⇒ materialization-free capture closure
        "function foo(){ return ()=>eval(\"this\"); }",
        // nested arrows: the eval flag bubbles through the whole arrow chain
        // to the nearest non-arrow function
        "function foo(){ return () => () => eval(\"this\"); }",
        // variant: the enclosing function is ALSO directly eval-poisoned, so it
        // gains `mxArgumentsFlag` (direct eval) and DOES materialize a real
        // `arguments` object alongside the arrow capture closure
        "function foo(){ eval(\"0\"); return ()=>eval(\"this\"); }",
        // contrast: the arrow captures `arguments` literally (not via eval), so
        // the enclosing function bubbles `mxArgumentsFlag` and materializes
        "function foo(){ return () => arguments; }",
        // an enclosing function with a parameter, so the synthetic closure
        // slot follows the parameter in the frame
        "function foo(a){ return ()=>eval(\"a\"); }",
    ]);
}

// A **named function expression** whose body has a direct `eval` — the fix5
// self-name-publish slice. XS declares the self-name `fxDefineNodeNew(…,
// XS_TOKEN_CONST)`: a define entry whose declare token is `CONST`, so
// `fxScopeCodingParams`' eval `with`-publish loop stores it alongside the
// `arguments` `VAR`. ironhorse models the self-name as the sole `Define` in a
// function param scope, so it must publish on the same footing — otherwise the
// direct eval sees `arguments` but not the function's own name, one `STORE_1`
// short. (`arguments-object/10.5-1-s.js`.)
#[test]
fn named_function_expression_self_name_under_eval() {
    assert_identical(&[
        // the 10.5-1-s shape: self-name + injected `arguments`, both published
        "(function fun() { eval('arguments = 10'); })(30);",
        // self-name only referenced through eval
        "(function f() { eval('f'); })();",
        // with a parameter, so the publish order is param, self-name, arguments
        "(function g(a) { eval('a + g'); })(1);",
    ]);
}

// Optional **call** (`fn?.(…)`, `a?.b?.()`) — the fix5 optional-chain
// call-reference slice. When a `?.` link is the *reference* of a call, the
// callee is pushed as a receiver/value pair, so `fxOptionNodeCodeThis` must
// short-circuit the whole chain with a `SWAP`/`POP` receiver drop when the
// base is nullish — not the plain `fxOptionNodeCode` `BRANCH_CHAIN`. ironhorse's
// `code_this` dispatch lacked the `Chain`/`Option` arms and fell through to the
// plain-value fallback, emitting the shorter (missing branch/swap/pop) stream.
#[test]
fn optional_call_reference_is_byte_identical() {
    assert_identical(&[
        // optional call on a bare (non-member) reference
        "var fn = () => 1; fn?.();",
        "var fn = (a, b) => a + b; fn?.(10, 20);",
        // optional call on a member reference
        "var a = { b() { return 1; } }; a.b?.();",
        // chained: optional access then optional call
        "var a = { b: () => 1 }; a?.b?.();",
        // optional call whose result is further chained
        "var a = { b: () => ({ c: 3 }) }; a?.b?.().c;",
    ]);
}

// `import.meta` is an early Syntax Error unless the syntactic goal is Module
// (`fxLiteralExpression`'s `mxProgramFlag` gate). The `compile` path is the
// script/eval goal, so every `import.meta` — top level or nested in a function
// (the flag survives `mxParserFlags` across function bodies) — must reject in
// agreement with the oracle. (`expressions/import.meta/syntax/goal-script.js`,
// `expressions/dynamic-import/.../import-meta.js`.)
#[test]
fn import_meta_in_script_goal_rejects() {
    assert_both_reject(&[
        "import.meta;",
        "import.meta.url;",
        "function f() { import.meta; }",
        "var p = import(import.meta);",
        "(() => import.meta)();",
    ]);
}

// `ContainsDuplicateLabels` — a label may not re-declare one already in scope,
// whether directly nested (`L: L: 0;`) or across an intervening statement
// (`L: { L: 0; }`). `fxLabelNodeCode` folds the direct chain and walks the
// enclosing break-target stack; both must reject in agreement with the oracle,
// while distinct-label nestings stay accepted and byte-identical.
// (`module-code/early-dup-lables.js`.)
#[test]
fn duplicate_labels_reject() {
    assert_both_reject(&[
        // across an intervening block (the early-dup-lables shape)
        "label: { label: 0; }",
        // directly nested
        "a: a: 0;",
        // re-declared two blocks deep
        "outer: { inner: { outer: 0; } }",
    ]);
}

#[test]
fn distinct_nested_labels_accept() {
    assert_identical(&[
        // distinct labels nested through a block stay legal
        "outer: { inner: 0; }",
        // directly chained distinct labels
        "a: b: 0;",
        // same label re-used in sibling (non-nested) scopes is fine
        "a: { 0; } a: { 1; }",
        // label reachable by an inner break
        "loop: while (1) { break loop; }",
    ]);
}
