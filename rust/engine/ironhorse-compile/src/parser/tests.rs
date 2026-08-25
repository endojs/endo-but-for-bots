//! AST fixture tests for the expression grammar — the crate's
//! **dump-and-compare** bar. Each case parses an expression and asserts
//! its [`crate::ast::dump`] against a pinned S-expression that encodes
//! the XS tree shape (node kind, child order, flags) the byte-identity
//! coder downstream depends on. The dumps were read off
//! `c/moddable/xs/sources/xsSyntaxical.c` at the oracle pin, construct by
//! construct.

use crate::ast::dump;
use crate::parser::{ParseErrorKind, Parser};

/// Parse `src` as a whole Script (sloppy) and dump the `Program` tree.
fn prog(src: &str) -> String {
    let mut p = Parser::new(src, false, false).unwrap_or_else(|e| panic!("lex {src:?}: {e}"));
    let item = p.parse_program(false).unwrap_or_else(|e| panic!("parse {src:?}: {e}"));
    dump(&item)
}

/// A table of `(source, expected-program-dump)` pairs.
fn check_prog(cases: &[(&str, &str)]) {
    for (src, want) in cases {
        let got = prog(src);
        assert_eq!(&got, want, "\n  source:   {src}\n  expected: {want}\n  got:      {got}");
    }
}

/// Parse `src` as an assignment expression (sloppy mode) and dump it.
fn expr(src: &str) -> String {
    let mut p = Parser::new(src, false, false).unwrap_or_else(|e| panic!("lex {src:?}: {e}"));
    let item = p.parse_assignment_expression().unwrap_or_else(|e| panic!("parse {src:?}: {e}"));
    dump(&item)
}

/// Parse `src` as a comma expression (sloppy) and dump it.
fn comma(src: &str) -> String {
    let mut p = Parser::new(src, false, false).unwrap();
    let item = p.parse_comma_expression().unwrap_or_else(|e| panic!("parse {src:?}: {e}"));
    dump(&item)
}

/// A table of `(source, expected-dump)` pairs, asserted one by one.
fn check(cases: &[(&str, &str)]) {
    for (src, want) in cases {
        let got = expr(src);
        assert_eq!(&got, want, "\n  source:   {src}\n  expected: {want}\n  got:      {got}");
    }
}

#[test]
fn literals() {
    check(&[
        ("1", "(Integer 1)"),
        ("42", "(Integer 42)"),
        ("1.5", "(Number 1.5)"),
        ("3.14", "(Number 3.14)"),
        // XS canonicalizes any integer-valued literal — including `1e3`
        // — to XS_TOKEN_INTEGER (`fxGetNextNumber`), so this is an
        // Integer, not a Number.
        ("1e3", "(Integer 1000)"),
        ("0x10n", "(BigInt 10n/16)"),
        ("0b101n", "(BigInt 101n/2)"),
        ("\"hi\"", "(String \"hi\")"),
        ("''", "(String \"\")"),
        ("true", "(True)"),
        ("false", "(False)"),
        ("null", "(Null)"),
        ("this", "(This)"),
        ("x", "(Access #x)"),
    ]);
}

#[test]
fn member_and_call() {
    check(&[
        ("x.y", "(Member (Access #x) #y)"),
        ("x.y.z", "(Member (Member (Access #x) #y) #z)"),
        ("x[0]", "(MemberAt (Access #x) (Integer 0))"),
        ("x[a+b]", "(MemberAt (Access #x) (Add (Access #a) (Access #b)))"),
        ("x.#p", "(PrivateMember ##p (Access #x))"),
        ("f()", "(Call (Access #f) (Params []))"),
        ("f(1, 2)", "(Call (Access #f) (Params [(Integer 1) (Integer 2)]))"),
        ("f(...a)", "(Call (Access #f) (Params :spread [(Spread (Access #a))]))"),
        ("a.b(c)", "(Call (Member (Access #a) #b) (Params [(Access #c)]))"),
    ]);
}

#[test]
fn new_expressions() {
    check(&[
        ("new X", "(New (Access #X) (Params []))"),
        ("new X()", "(New (Access #X) (Params []))"),
        ("new X(1)", "(New (Access #X) (Params [(Integer 1)]))"),
        ("new a.b(1)", "(New (Member (Access #a) #b) (Params [(Integer 1)]))"),
        ("new X(1).y", "(Member (New (Access #X) (Params [(Integer 1)])) #y)"),
    ]);
}

#[test]
fn new_target_needs_function_context() {
    // At program top level, `mxTargetFlag` is unset, so `new.target` is
    // an early error — exactly as XS reports it.
    let mut p = Parser::new("new.target", false, false).unwrap();
    let err = p.parse_assignment_expression().unwrap_err();
    assert_eq!(err.kind, ParseErrorKind::Syntax);
    assert!(err.message.contains("new.target"), "{}", err.message);
}

#[test]
fn import_forms() {
    check(&[
        ("import.meta", "(ImportMeta)"),
        ("import(\"m\")", "(ImportCall (String \"m\") ())"),
        ("import(\"m\", o)", "(ImportCall (String \"m\") (Access #o))"),
    ]);
}

#[test]
fn optional_chaining() {
    check(&[
        ("a?.b", "(Chain (Member (Option (Access #a)) #b))"),
        ("a?.b.c", "(Chain (Member (Member (Option (Access #a)) #b) #c))"),
        ("a?.[0]", "(Chain (MemberAt (Option (Access #a)) (Integer 0)))"),
        ("a?.()", "(Chain (Call (Option (Access #a)) (Params [])))"),
        ("a?.#p", "(Chain (PrivateMember ##p (Option (Access #a))))"),
    ]);
}

#[test]
fn operators_precedence_and_associativity() {
    check(&[
        // multiplicative binds tighter than additive
        ("a+b*c", "(Add (Access #a) (Multiply (Access #b) (Access #c)))"),
        ("a*b+c", "(Add (Multiply (Access #a) (Access #b)) (Access #c))"),
        // exponentiation is right-associative
        ("a**b**c", "(Exponent (Access #a) (Exponent (Access #b) (Access #c)))"),
        // additive is left-associative
        ("a-b-c", "(Subtract (Subtract (Access #a) (Access #b)) (Access #c))"),
        ("a%b", "(Modulo (Access #a) (Access #b))"),
        ("a<<b", "(LeftShift (Access #a) (Access #b))"),
        ("a>>b", "(SignedRightShift (Access #a) (Access #b))"),
        ("a>>>b", "(UnsignedRightShift (Access #a) (Access #b))"),
        ("a<b", "(Less (Access #a) (Access #b))"),
        ("a<=b", "(LessEqual (Access #a) (Access #b))"),
        ("a instanceof b", "(Instanceof (Access #a) (Access #b))"),
        ("a in b", "(In (Access #a) (Access #b))"),
        ("a==b", "(Equal (Access #a) (Access #b))"),
        ("a!=b", "(NotEqual (Access #a) (Access #b))"),
        ("a===b", "(StrictEqual (Access #a) (Access #b))"),
        ("a!==b", "(StrictNotEqual (Access #a) (Access #b))"),
        ("a&b", "(BitAnd (Access #a) (Access #b))"),
        ("a^b", "(BitXor (Access #a) (Access #b))"),
        ("a|b", "(BitOr (Access #a) (Access #b))"),
        // && binds tighter than ||
        ("a&&b||c", "(Or (And (Access #a) (Access #b)) (Access #c))"),
        ("a??b", "(Coalesce (Access #a) (Access #b))"),
        // relational binds tighter than equality
        ("a<b==c", "(Equal (Less (Access #a) (Access #b)) (Access #c))"),
    ]);
}

#[test]
fn private_in() {
    // XS's descriptions table spells this node "PrivateIdenfifier"
    // (sic); the dump preserves XS's spelling for fidelity.
    check(&[("#x in obj", "(PrivateIdenfifier ##x (Access #obj))")]);
}

#[test]
fn unary_update() {
    check(&[
        ("!a", "(Not (Access #a))"),
        ("~a", "(BitNot (Access #a))"),
        ("+a", "(Plus (Access #a))"),
        ("-a", "(Minus (Access #a))"),
        ("typeof a", "(Typeof (Access #a))"),
        ("void 0", "(Void (Integer 0))"),
        ("delete a.b", "(Delete (Member (Access #a) #b))"),
        ("++a", "(Increment :novalue (Access #a))"),
        ("--a", "(Decrement :novalue (Access #a))"),
        ("a++", "(Increment (Access #a))"),
        ("a--", "(Decrement (Access #a))"),
    ]);
}

#[test]
fn conditional_and_assignment() {
    check(&[
        ("a?b:c", "(QuestionMark (Access #a) (Access #b) (Access #c))"),
        ("a=b", "(Assign (Access #a) (Access #b))"),
        // assignment is right-associative
        ("a=b=c", "(Assign (Access #a) (Assign (Access #b) (Access #c)))"),
        ("a+=b", "(AddAssign (Access #a) (Access #b))"),
        ("a-=b", "(SubtractAssign (Access #a) (Access #b))"),
        ("a*=b", "(MultiplyAssign (Access #a) (Access #b))"),
        ("a**=b", "(ExponentAssign (Access #a) (Access #b))"),
        ("a&&=b", "(AndAssign (Access #a) (Access #b))"),
        ("a||=b", "(OrAssign (Access #a) (Access #b))"),
        ("a??=b", "(CoalesceAssign (Access #a) (Access #b))"),
        ("a>>>=b", "(UnsignedRightShiftAssign (Access #a) (Access #b))"),
        // member and computed targets are valid references
        ("a.b=c", "(Assign (Member (Access #a) #b) (Access #c))"),
        ("a[i]=c", "(Assign (MemberAt (Access #a) (Access #i)) (Access #c))"),
    ]);
}

#[test]
fn comma_expressions() {
    assert_eq!(comma("a,b,c"), "(Expressions [(Access #a) (Access #b) (Access #c)])");
    // a lone expression through the comma entry is not wrapped
    assert_eq!(comma("a"), "(Access #a)");
}

#[test]
fn parenthesized() {
    check(&[
        ("(a)", "(Expressions [(Access #a)])"),
        ("(a,b)", "(Expressions [(Access #a) (Access #b)])"),
        ("(a+b)*c", "(Multiply (Expressions [(Add (Access #a) (Access #b))]) (Access #c))"),
    ]);
    // a parenthesized single reference is a valid assignment target
    // (fxCheckReference unwraps the cover).
    check(&[("(a)=b", "(Assign (Access #a) (Access #b))")]);
}

#[test]
fn array_literals() {
    check(&[
        ("[]", "(Array [])"),
        ("[1, 2]", "(Array [(Integer 1) (Integer 2)])"),
        ("[1, , 2]", "(Array [(Integer 1) (?) (Integer 2)])"),
        ("[, a]", "(Array [(?) (Access #a)])"),
        ("[1, ]", "(Array :elision [(Integer 1)])"),
        ("[...x]", "(Array :spread [(Spread (Access #x))])"),
        (
            "[1, , 2, ...x]",
            "(Array :spread [(Integer 1) (?) (Integer 2) (Spread (Access #x))])",
        ),
    ]);
}

#[test]
fn object_literals() {
    check(&[
        ("({})", "(Expressions [(Object [])])"),
        ("({a: 1})", "(Expressions [(Object [(Property #a (Integer 1))])])"),
        ("({b})", "(Expressions [(Object [(Property :shorthand #b (Access #b))])])"),
        (
            "({c = 2})",
            "(Expressions [(Object [(Property :shorthand #c (Binding (Access #c) (Integer 2)))])])",
        ),
        ("({[d]: 3})", "(Expressions [(Object [(PropertyAt (Access #d) (Integer 3))])])"),
        ("({\"s\": 1})", "(Expressions [(Object [(Property #s (Integer 1))])])"),
        ("({0: 1})", "(Expressions [(Object [(PropertyAt (Integer 0) (Integer 1))])])"),
        // `fxStringToIndex`: a string key that is a canonical array index
        // codes through the integer (`PropertyAt`) path, exactly as `0`
        // does; a non-canonical string stays a symbol (`Property`).
        ("({\"1\": 1})", "(Expressions [(Object [(PropertyAt (Integer 1) (Integer 1))])])"),
        ("({\"0\": 1})", "(Expressions [(Object [(PropertyAt (Integer 0) (Integer 1))])])"),
        // Negative cases: a leading zero, a fractional string, and the
        // 2^32-1 sentinel are NOT canonical indexes — they stay symbols.
        ("({\"01\": 1})", "(Expressions [(Object [(Property #01 (Integer 1))])])"),
        ("({\"1.5\": 1})", "(Expressions [(Object [(Property #1.5 (Integer 1))])])"),
        (
            "({\"4294967295\": 1})",
            "(Expressions [(Object [(Property #4294967295 (Integer 1))])])",
        ),
        ("({...e})", "(Expressions [(Object [(Spread (Access #e))])])"),
    ]);
}

#[test]
fn duplicate_proto_setters_are_an_early_error() {
    let invalid = "({ __proto__: null, other: 1, '__proto__': null })";
    let mut parser = Parser::new(invalid, false, false).expect("lexes");
    let error = parser
        .parse_program(false)
        .expect_err("two prototype setters must be rejected");
    assert!(error.message.contains("duplicate __proto__"), "{error}");

    for valid in [
        "({ __proto__: null, ['__proto__']: null })",
        "({ __proto__, '__proto__': null })",
        "({ __proto__() {}, '__proto__': null })",
        "({ __proto__: x, __proto__: y } = value)",
        "({ __proto__: x, __proto__: y }) => 0",
        "for ({ __proto__: x, __proto__: y } of []) {}",
        "function f({ __proto__: x, __proto__: y }) {}",
    ] {
        prog(valid);
    }
}

#[test]
fn templates() {
    check(&[
        ("`abc`", "(Template () [(TemplateItem (String \"abc\") (String \"abc\"))])"),
        (
            "`a${x}b`",
            "(Template () [(TemplateItem (String \"a\") (String \"a\")) (Access #x) (TemplateItem (String \"b\") (String \"b\"))])",
        ),
        (
            "tag`a${x}b`",
            "(Template (Access #tag) [(TemplateItem (String \"a\") (String \"a\")) (Access #x) (TemplateItem (String \"b\") (String \"b\"))])",
        ),
        (
            "f()`x`",
            "(Template (Call (Access #f) (Params [])) [(TemplateItem (String \"x\") (String \"x\"))])",
        ),
    ]);
}

#[test]
fn regexp_vs_divide() {
    check(&[
        // division: `/` in operator position
        ("a/b", "(Divide (Access #a) (Access #b))"),
        ("a/=b", "(DivideAssign (Access #a) (Access #b))"),
        // regexp literal: `/` in expression position, delimited by the
        // parser calling back into the lexer
        ("/re/gi", "(Regexp (String \"gi\") (String \"re\"))"),
        ("/a\\/b/", "(Regexp (String \"\") (String \"a\\\\/b\"))"),
    ]);
}

#[test]
fn formerly_deferred_constructs_now_parse() {
    // Arrow / function / class expressions, object methods, and
    // destructuring assignment targets were deferred by child 2; child 3
    // (this crate's statement grammar) parses them. They must now yield a
    // tree, not [`ParseErrorKind::Unsupported`].
    for src in ["x => x", "(a, b) => a", "function () {}", "class {}", "({ m() {} })", "[a] = b"] {
        let mut p = Parser::new(src, false, false).unwrap();
        let item = p.parse_assignment_expression().unwrap_or_else(|e| panic!("parse {src:?}: {e}"));
        let _ = dump(&item);
    }
}

#[test]
fn valid_unported_import_attributes_are_unsupported() {
    for source in ["import value from 'm' with { type: 'json' };", "export * from 'm' with { type: 'json' };"] {
        let mut parser = Parser::new(source, true, false).unwrap();
        let error = parser.parse_module().expect_err("import attributes are not yet ported");
        assert_eq!(error.kind, ParseErrorKind::Unsupported);
        assert!(error.message.contains("import attributes"));
    }
}

#[test]
fn malformed_input_never_panics() {
    // The fuzz target (a later child) depends on this: every byte
    // sequence yields a Result, never a panic.
    for src in ["", "(", ")", "1 +", "a.", "a?.", "[", "{", "`", "/", "@#$", "1n.2", "a ** ** b"] {
        let mut p = match Parser::new(src, false, false) {
            Ok(p) => p,
            Err(_) => continue, // a lex error before the first token is fine
        };
        let _ = p.parse_comma_expression(); // Ok or Err, but no panic
    }
}

#[test]
fn parse_meter_accrues_per_token() {
    // The meter (ironhorse's own frozen cost table) advances monotonically
    // across a parse; a larger expression costs at least as much.
    let mut small = Parser::new("a", false, false).unwrap();
    small.parse_comma_expression().unwrap();
    let mut big = Parser::new("a + b * (c - d)", false, false).unwrap();
    big.parse_comma_expression().unwrap();
    assert!(big.meter().computrons() >= small.meter().computrons());
    assert!(small.meter().computrons() > 0);
}

#[test]
fn await_in_module_context() {
    // In a module (async top-level), `await x` is a unary Await with the
    // awaiting flag threaded onto the parser state.
    // In module mode the parser carries mxStrictFlag|mxAsyncFlag, and
    // `fxPushNodeStruct` stamps those inherited bits onto every node it
    // builds — so the dump faithfully shows `:strict :async`.
    let mut p = Parser::new("await x", false, true).unwrap();
    let item = p.parse_assignment_expression().unwrap();
    assert_eq!(dump(&item), "(Await :strict :async (Access :strict :async #x))");
}

#[test]
fn no_reference_is_a_syntax_error() {
    // Assigning into a non-reference (a literal) is an early error, not
    // a panic.
    let mut p = Parser::new("1 = 2", false, false).unwrap();
    let err = p.parse_assignment_expression().unwrap_err();
    assert_eq!(err.kind, ParseErrorKind::Syntax);
}

// ============================================================
// Statement / declaration fixtures (stage-5 child 3). Each dump was read
// off `xsSyntaxical.c` construct by construct and pins the tree shape —
// node kind, child order, and the parser flags XS stamps — that the
// byte-identity coder downstream depends on.
// ============================================================

/// Parse `src` as a Module and dump the `Module` tree.
fn module(src: &str) -> String {
    let mut p = Parser::new(src, false, true).unwrap_or_else(|e| panic!("lex {src:?}: {e}"));
    let item = p.parse_module().unwrap_or_else(|e| panic!("parse {src:?}: {e}"));
    dump(&item)
}

#[test]
fn variable_declarations() {
    check_prog(&[
        ("var x = 1;", "(Program (Binding (Var #x) (Integer 1)))"),
        ("var x;", "(Program (Var #x))"),
        (
            "let a, b = 2;",
            "(Program (Statements [(Let #a) (Binding (Let #b) (Integer 2))]))",
        ),
        ("const k = 3;", "(Program (Binding (Const #k) (Integer 3)))"),
    ]);
}

#[test]
fn destructuring_declarations() {
    check_prog(&[
        (
            "const {a, b: c} = o;",
            "(Program (Binding (ObjectBinding [(PropertyBinding #a (Const #a)) (PropertyBinding #b (Const #c))]) (Access #o)))",
        ),
        (
            "const [x, , ...y] = a;",
            "(Program (Binding (ArrayBinding [(Const #x) (SkipBinding) (RestBinding (Const #y))]) (Access #a)))",
        ),
        (
            "var {a} = b, [c] = d;",
            "(Program (Statements [(Binding (ObjectBinding [(PropertyBinding #a (Var #a))]) (Access #b)) (Binding (ArrayBinding [(Var #c)]) (Access #d))]))",
        ),
    ]);
}

#[test]
fn destructuring_assignment_target() {
    // A `[a, b] = c` assignment: `fxCheckReference` reparses the array
    // literal into an `ArrayBinding`.
    check_prog(&[(
        "[a, b] = c",
        "(Program (Statement (Assign (ArrayBinding [(Access #a) (Access #b)]) (Access #c))))",
    )]);
}

#[test]
fn control_flow_statements() {
    check_prog(&[
        (
            "if (a) b; else c;",
            "(Program (If (Access #a) (Statement (Access #b)) (Statement (Access #c))))",
        ),
        (
            "while (a) b;",
            "(Program (Label () (While (Access #a) (Statement (Access #b)))))",
        ),
        (
            "do x; while (a);",
            "(Program (Label () (Do (Statement (Access #x)) (Access #a))))",
        ),
        (
            "with (o) x;",
            "(Program (With (Access #o) (Statement (Access #x))))",
        ),
        ("debugger;", "(Program (Debugger))"),
        (
            "a; b;",
            "(Program (Statements [(Statement (Access #a)) (Statement (Access #b))]))",
        ),
        (
            "{ let x = 1; }",
            "(Program (Block (Statements [(Binding (Let #x) (Integer 1))])))",
        ),
    ]);
}

#[test]
fn loop_headers() {
    check_prog(&[
        (
            "for (var i = 0; i < 10; i++) x;",
            "(Program (Label () (For (Binding (Var #i) (Integer 0)) (Less (Access #i) (Integer 10)) (Increment (Access #i)) (Statement (Access #x)))))",
        ),
        (
            "for (const k in o) x;",
            "(Program (Label () (ForIn (Const #k) (Access #o) (Statement (Access #x)))))",
        ),
        (
            "for (const v of a) x;",
            "(Program (Label () (ForOf (Const #v) (Access #a) (Statement (Access #x)))))",
        ),
        (
            "label: for (;;) break label;",
            "(Program (Label #label (Label () (For () () () (Break #label)))))",
        ),
    ]);
}

#[test]
fn switch_and_try() {
    check_prog(&[
        (
            "switch (x) { case 1: a; break; default: b; }",
            "(Program (Switch (Access #x) [(Case (Integer 1) (Statements [(Statement (Access #a)) (Break ())])) (Case () (Statement (Access #b)))]))",
        ),
        (
            "try { a; } catch (e) { b; } finally { c; }",
            "(Program (Try (Block (Statements [(Statement (Access #a))])) (Catch (Let #e) (Statements [(Statement (Access #b))])) (Block (Statements [(Statement (Access #c))]))))",
        ),
    ]);
}

#[test]
fn function_and_arrow_declarations() {
    check_prog(&[
        (
            "function f(a, b) { return a + b; }",
            "(Program (Define #f (Function :target #f (ParamsBinding [(Arg #a) (Arg #b)]) (Body (Return (Add (Access #a) (Access #b)))))))",
        ),
        (
            "x => x + 1",
            "(Program (Statement (Function :arrow () (ParamsBinding [(Arg #x ())]) (Body (Return (Add (Access #x) (Integer 1)))))))",
        ),
        (
            "(a, b) => a",
            "(Program (Statement (Function :arrow () (ParamsBinding [(Arg #a) (Arg #b)]) (Body (Return (Access #a))))))",
        ),
        (
            "async function f() { await x; }",
            "(Program (Define #f (Function :target :async #f (ParamsBinding :async []) (Body :async (Statement :async (Await :async (Access :async #x)))))))",
        ),
        (
            "function* g() { yield 1; }",
            "(Program (Define #g (Generator :generator #g (ParamsBinding :generator []) (Body :generator (Statement :generator (Yield :generator (Integer 1)))))))",
        ),
    ]);
}

#[test]
fn class_declaration() {
    // Members are parsed faithfully and kept in the `items` list in source
    // order; the field/static-block → init-function surgery is folded to
    // the coder (so the two init slots are `()`). Everything inside a class
    // body is strict, hence the pervasive `:strict`.
    check_prog(&[(
        "class C extends B { m() {} static s() {} #p = 1; }",
        "(Program (Binding (Let #C) (Class :strict #C (Access :strict #B) \
         [(Property :strict :method #m (Function :strict :super :target :method () (ParamsBinding :strict []) (Body :strict (Statement :strict (Undefined :strict))))) \
         (Property :strict :method :static #s (Function :strict :super :target :method :static () (ParamsBinding :strict []) (Body :strict (Statement :strict (Undefined :strict))))) \
         (PrivateProperty :strict ##p (Integer 1))] () () \
         (Function :strict :super :target :derived :method () (ParamsBinding :strict [(RestBinding :strict (Arg :strict #args ()))]) (Body :strict (Statement :strict (Super :strict (Params :strict :spread [(Spread :strict (Access :strict #args))]))))))))",
    )]);
}

#[test]
fn bare_arrow_is_not_a_class_heritage_left_hand_side_expression() {
    for invalid in [
        "class C extends () => {} {}",
        "var C = class extends () => {} {};",
    ] {
        let mut parser = Parser::new(invalid, false, false).expect("lexes");
        let error = parser
            .parse_program(false)
            .expect_err("bare arrow heritage must be rejected");
        assert!(error.message.contains("invalid arrow function"), "{error}");
    }

    // Parentheses turn the arrow into the permitted LeftHandSideExpression.
    prog("class C extends (() => {}) {}");
}

#[test]
fn object_methods_and_accessors() {
    check_prog(&[(
        "({ get x() { return 1; }, *gen() {}, async af() {} })",
        "(Program (Statement (Expressions [(Object \
         [(Property :getter :shorthand #x (Function :super :target () (ParamsBinding []) (Body (Return (Integer 1))))) \
         (Property :method :shorthand #gen (Generator :super :generator :method :shorthand () (ParamsBinding :generator []) (Body :generator (Statement :generator (Undefined :generator))))) \
         (Property :async :method :shorthand #af (Function :super :target :async :method :shorthand () (ParamsBinding :async []) (Body :async (Statement :async (Undefined :async)))))])])))",
    )]);
}

#[test]
fn module_imports() {
    check_prog_module(&[
        (
            "import x from 'm';",
            "(Module :strict (Import :strict :async [(Specifier :strict :async #default #x)] (String \"m\") ()))",
        ),
        (
            "import {a, b as c} from 'm';",
            "(Module :strict (Import :strict :async [(Specifier :strict :async #a ()) (Specifier :strict :async #b #c)] (String \"m\") ()))",
        ),
        (
            "import * as ns from 'm';",
            "(Module :strict (Import :strict :async [(Specifier :strict :async () #ns)] (String \"m\") ()))",
        ),
    ]);
}

#[test]
fn module_exports() {
    check_prog_module(&[
        (
            "export {a, b};",
            "(Module :strict (Export :strict :async [(Specifier :strict :async #a ()) (Specifier :strict :async #b ())] () ()))",
        ),
        (
            "export * from 'm';",
            "(Module :strict (Export :strict :async [(Specifier :strict :async () ())] (String \"m\") ()))",
        ),
        (
            "export const x = 1;",
            "(Module :strict (Statements :strict :async [(Binding :strict :async (Const :strict :async #x) (Integer 1)) (Export :strict :async [(Specifier :strict :async #x ())] () ())]))",
        ),
        (
            "export default 42;",
            "(Module :strict (Statements :strict :async [(Statement :strict :async (Assign :strict :async (Const :strict :async #default ()) (Integer 42))) (Export :strict :async [(Specifier :strict :async #default ())] () ())]))",
        ),
    ]);
}

/// `check_prog` for the module goal.
fn check_prog_module(cases: &[(&str, &str)]) {
    for (src, want) in cases {
        let got = module(src);
        assert_eq!(&got, want, "\n  source:   {src}\n  expected: {want}\n  got:      {got}");
    }
}

#[test]
fn directive_prologue_upgrades_strict() {
    // A `"use strict"` prologue flips strict mode, which then shows on the
    // Program root and every subsequently built node (inherited `:strict`).
    let out = prog("\"use strict\"; x;");
    assert_eq!(
        out,
        "(Program :strict (Statements :strict [(Statement (String \"use strict\")) (Statement :strict (Access :strict #x))]))"
    );
}

#[test]
fn statement_level_early_errors() {
    // Parser-level early errors XS raises (not scoper/coder ones): a
    // top-level `return`, and assignment into a literal.
    for src in ["return 1;", "1 = 2;"] {
        let mut p = Parser::new(src, false, false).unwrap();
        let err = p.parse_program(false).unwrap_err();
        assert_eq!(err.kind, ParseErrorKind::Syntax, "src {src:?}");
    }
}

#[test]
fn strict_delete_identifier_is_an_early_error() {
    for src in [
        r#""use strict"; delete name;"#,
        r#""use strict"; delete ((name));"#,
    ] {
        let err = prog_err(src);
        assert_eq!(err.kind, ParseErrorKind::Syntax, "src {src:?}");
        assert!(err.message.contains("invalid delete"), "{src:?}: {}", err.message);
    }
    prog_ok("delete name;");
    prog_ok(r#""use strict"; delete object.name;"#);
}

#[test]
fn program_never_panics_on_garbage() {
    // The whole-program entry upholds the fuzz invariant too.
    for src in ["}", "for(", "class", "function(", "if", "case 1:", "{{{{", "export", "import"] {
        let mut p = match Parser::new(src, false, false) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let _ = p.parse_program(false);
    }
}

/// Parse `src` as a whole Script and return the early error (or panic if it
/// was accepted). Used by the negative-fixture cases below.
fn prog_err(src: &str) -> crate::parser::ParseError {
    let mut p = Parser::new(src, false, false).unwrap_or_else(|e| panic!("lex {src:?}: {e}"));
    p.parse_program(false)
        .err()
        .unwrap_or_else(|| panic!("expected a syntax error for {src:?}"))
}

/// Assert `src` parses without an early error.
fn prog_ok(src: &str) {
    let mut p = Parser::new(src, false, false).unwrap_or_else(|e| panic!("lex {src:?}: {e}"));
    assert!(p.parse_program(false).is_ok(), "expected {src:?} to parse");
}

#[test]
fn nonsimple_params_with_use_strict_body_is_error() {
    // `fxBody`: a `"use strict"` directive with a non-simple parameter list
    // is a Syntax Error even when the function is ALREADY strict (a class
    // method, whose body inherits the class's strictness) — the regression
    // this slice fixes. Also covered: a plain strict-by-directive function
    // and default / rest / destructuring parameters.
    for src in [
        r#"class C { m(a, ...rest) { "use strict"; } }"#,
        r#"class C { m(a = 1) { "use strict"; } }"#,
        r#"class C { static m({x}) { "use strict"; } }"#,
        r#"function f(a = 1) { "use strict"; }"#,
        r#"(function (...a) { "use strict"; })"#,
    ] {
        let err = prog_err(src);
        assert_eq!(err.kind, ParseErrorKind::Syntax, "src {src:?}");
        assert!(err.message.contains("invalid directive"), "{src:?}: {}", err.message);
    }
    // A simple parameter list with a `"use strict"` body stays legal.
    prog_ok(r#"function f(a, b) { "use strict"; }"#);
}

#[test]
fn arguments_in_class_field_initializer_is_error() {
    // The field branch of `fxClassExpression`: `arguments` in a field
    // initializer (ContainsArguments) is a Syntax Error — directly, inside a
    // nested arrow (which does not bind its own `arguments`), and for static
    // and private fields.
    for src in [
        "class C { x = arguments; }",
        "class C { x = typeof arguments; }",
        "class C { x = () => arguments; }",
        "class C { static x = arguments; }",
        "class C { #x = arguments; }",
    ] {
        let err = prog_err(src);
        assert_eq!(err.kind, ParseErrorKind::Syntax, "src {src:?}");
        assert!(err.message.contains("invalid arguments"), "{src:?}: {}", err.message);
    }
    // A nested ordinary function has its own `arguments`, so it is legal.
    prog_ok("class C { x = function () { return arguments; }; }");
}

#[test]
fn untagged_template_illegal_escape_is_error() {
    // `fxStringNodeCode`: an untagged template literal whose cooked value
    // carries `mxStringErrorFlag` (a truncated/illegal `\x` / `\u` escape, an
    // invalid `\u{…}` code point or separator, or a legacy octal in template
    // position) is a SyntaxError. A *tagged* template accepts the same source
    // (its cooked slot becomes `undefined`), so the tag makes it legal.
    for src in [
        "`\\x0`;",          // truncated hex
        "`\\u0`;",          // truncated unicode
        "`\\unicode`;",     // non-hex after \u
        "`\\u{g`;",         // bad code point
        "`\\u{1F_639}`;",   // numeric separator not allowed in \u{}
        "`\\00`;",          // legacy octal in template
        "`a${1}\\xZZ`;",    // error in a later template part
    ] {
        let err = prog_err(src);
        assert_eq!(err.kind, ParseErrorKind::Syntax, "src {src:?}");
    }
    // The same illegal escapes are legal under a tag (cooked → undefined),
    // and legal escapes cook cleanly in an untagged template.
    prog_ok("var t = s => s; t`\\x0`;");
    prog_ok("var t = s => s; t`\\u{1F_639}`;");
    prog_ok("`a\\tb\\u0041c`;");
}

#[test]
fn arguments_and_await_in_static_block_are_errors() {
    // A static initialization block is a field context: `arguments` and a
    // top-level `await` are Syntax Errors.
    let err = prog_err("class C { static { arguments; } }");
    assert!(err.message.contains("invalid arguments"), "{}", err.message);
    let err = prog_err("class C { static { await 1; } }");
    assert!(err.message.contains("invalid await"), "{}", err.message);
}

#[test]
#[should_panic(expected = "invalid initializer")]
fn cover_initialized_name_as_expression_is_error() {
    // `fxBindingNodeCode`: a shorthand-with-initializer (CoverInitializedName)
    // in an object literal used as a real expression — never refined to a
    // destructuring pattern — is a Syntax Error (raised at code time, like
    // XS's `fxReportParserError`).
    let _ = crate::coder::compile("({ a = 1 });");
}

#[test]
fn cover_initialized_name_as_destructuring_target_is_ok() {
    // The same shape as a destructuring assignment target is legal.
    assert!(crate::coder::compile("({ a = 1 } = {});").is_ok());
    assert!(crate::coder::compile("var { a = 1 } = {};").is_ok());
}
