//! The abstract-syntax-tree model, mirroring XS's `txNode` kinds and
//! layouts from `c/moddable/xs/sources/xsScript.h` at the oracle pin
//! (design § roadmap row 5; Design Decisions 4 and 5).
//!
//! This is **not** a "nicer" AST: the scoper and coder downstream are
//! held to byte-identity against XS, and the exact tree shapes — which
//! node kind XS synthesizes for each construct, the order of a node's
//! child slots, and the parser flags stamped onto a node — are the spec.
//! So a node here carries the same `token` (its `description->token`),
//! the same `line`, the same `flags` bits, and its children in XS's own
//! slot order.
//!
//! XS builds the tree on a pointer stack (`fxPushNode` / `fxPopNode` /
//! `fxPushNodeStruct`, `xsSyntaxical.c`). A stack slot — and therefore a
//! node's child slot — is one of four things, captured by [`Item`]: a
//! real node, a bare symbol (XS's `fxPushSymbol`, aliased into a
//! `txNode*` slot), a `NULL` placeholder (`fxPushNULL`), or a node list
//! (`fxPushNodeList`, a `txNodeList` with the `XS_NO_TOKEN` description).
//! We model those four cases explicitly rather than reproduce the C
//! pointer-aliasing trick.

use crate::token::Token;

/// The parser-flag bits XS stamps onto nodes (`xsScript.h` `enum`). Only
/// the bits the expression grammar sets are named here; the rest arrive
/// with the scoper/coder stages. Values are XS's exact bit positions so
/// a node's `flags` word matches XS.
pub mod flags {
    /// `mxCFlag` — host (`@`) mode. (bit 0)
    pub const C: u32 = 1 << 0;
    /// `mxStringErrorFlag` — a template/string cooked value that carries an
    /// illegal escape sequence. In a tagged template the cooked slot becomes
    /// `undefined` (the raw slot is still emitted); anywhere else `fxStringNodeCode`
    /// turns it into a SyntaxError. (bit 1)
    pub const STRING_ERROR: u32 = 1 << 1;
    /// `mxEvalFlag`. (bit 2)
    pub const EVAL: u32 = 1 << 2;
    /// `mxStringLegacyFlag` — bit 2 in its **String-node** meaning: the
    /// string carried a legacy (non-simple) octal escape or `\8`/`\9`, a
    /// sloppy-mode-only allowance. `fxStringNodeHoist` upgrades it to
    /// `STRING_ERROR` (a SyntaxError) when the enclosing scope is strict.
    /// Reuses bit 2 exactly as XS does — a String node never carries
    /// `EVAL`, so the two never collide on one node.
    pub const STRING_LEGACY: u32 = 1 << 2;
    /// `mxProgramFlag` — set while parsing a Script goal (not a Module).
    /// (bit 3)
    pub const PROGRAM: u32 = 1 << 3;
    /// `mxStrictFlag`. (bit 4)
    pub const STRICT: u32 = 1 << 4;
    /// `mxSuperFlag`. (bit 5)
    pub const SUPER: u32 = 1 << 5;
    /// `mxTargetFlag`. (bit 6)
    pub const TARGET: u32 = 1 << 6;
    /// `mxArgumentsFlag`. (bit 7)
    pub const ARGUMENTS: u32 = 1 << 7;
    /// `mxArrowFlag`. (bit 8)
    pub const ARROW: u32 = 1 << 8;
    /// `mxAsyncFlag`. (bit 9)
    pub const ASYNC: u32 = 1 << 9;
    /// `mxAwaitingFlag`. (bit 10)
    pub const AWAITING: u32 = 1 << 10;
    /// `mxBaseFlag`. (bit 11)
    pub const BASE: u32 = 1 << 11;
    /// `mxNativeFlag`. (bit 12)
    pub const NATIVE: u32 = 1 << 12;
    /// `mxHostFlag`. (bit 13)
    pub const HOST: u32 = 1 << 13;
    /// `mxDefaultFlag`. (bit 14)
    pub const DEFAULT: u32 = 1 << 14;
    /// `mxFieldFlag`. (bit 15)
    pub const FIELD: u32 = 1 << 15;
    /// `mxFunctionFlag`. (bit 16)
    pub const FUNCTION: u32 = 1 << 16;
    /// `mxDerivedFlag`. (bit 17)
    pub const DERIVED: u32 = 1 << 17;
    /// `mxElisionFlag`. (bit 18)
    pub const ELISION: u32 = 1 << 18;
    /// `mxExpressionNoValue`. (bit 19)
    pub const EXPRESSION_NO_VALUE: u32 = 1 << 19;
    /// `mxForFlag`. (bit 20)
    pub const FOR: u32 = 1 << 20;
    /// `mxGeneratorFlag`. (bit 21)
    pub const GENERATOR: u32 = 1 << 21;
    /// `mxGetterFlag`. (bit 22)
    pub const GETTER: u32 = 1 << 22;
    /// `mxMethodFlag`. (bit 23)
    pub const METHOD: u32 = 1 << 23;
    /// `mxNotSimpleParametersFlag`. (bit 24)
    pub const NOT_SIMPLE_PARAMETERS: u32 = 1 << 24;
    /// `mxSetterFlag`. (bit 25)
    pub const SETTER: u32 = 1 << 25;
    /// `mxShorthandFlag`. (bit 26)
    pub const SHORTHAND: u32 = 1 << 26;
    /// `mxSpreadFlag`. (bit 27)
    pub const SPREAD: u32 = 1 << 27;
    /// `mxStaticFlag`. (bit 28)
    pub const STATIC: u32 = 1 << 28;
    /// `mxYieldFlag`. (bit 30)
    pub const YIELD: u32 = 1 << 30;
    /// `mxYieldingFlag`. (bit 31)
    pub const YIELDING: u32 = 1 << 31;

    /// The subset XS's `fxPushNodeStruct` copies from `parser->flags`
    /// onto every freshly built node (`mxStrictFlag | mxGeneratorFlag |
    /// mxAsyncFlag`).
    pub const INHERITED: u32 = STRICT | GENERATOR | ASYNC;

    /// `mxParserFlags` = `mxCFlag | mxDebugFlag | mxProgramFlag` — the
    /// harness-context bits `fxFunctionExpression`/`fxGeneratorExpression`
    /// carry across into a nested function's fresh `parser->flags`.
    pub const PARSER_FLAGS: u32 = (1 << 0) | (1 << 1) | (1 << 3);
}

/// A leaf value a node can carry in place of (or beside) children — the
/// payload of XS's value-bearing node structs.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// No payload (the common case; all children).
    None,
    /// `txIntegerNode.value`.
    Integer(i32),
    /// `txNumberNode.value`.
    Number(f64),
    /// `txStringNode.value` (cooked), carried as UTF-16 code units — the
    /// same representation the engine (`ironhorse-vm`) settled on at stage 4.
    /// A `String` cannot hold the lone surrogates a JS string literal may
    /// contain (`"\uD800"`), and the coder must emit XS's CESU-8 (an astral
    /// scalar is a 6-byte surrogate pair, a lone surrogate a 3-byte unit),
    /// which is a per-code-unit encoding — so the value is code units end
    /// to end, encoded to CESU-8 only at the coder ([`str_to_units`] /
    /// [`units_to_cesu8`]).
    Str(Vec<u16>),
    /// `txBigIntNode` — the scanned literal (digits + radix).
    BigInt(crate::lexer::BigIntLiteral),
}

/// One stack slot / child slot: the four things XS can push.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    /// A real AST node.
    Node(Box<Node>),
    /// A bare symbol (`fxPushSymbol`).
    Symbol(String),
    /// A `NULL` placeholder (`fxPushNULL`).
    Null,
    /// A node list (`fxPushNodeList`), its elements in source order.
    List(Vec<Item>),
}

/// An AST node: XS's `sxNode` common part (`description->token`, `line`,
/// `flags`) plus its child slots and any leaf payload.
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    /// The node kind — `description->token` in XS.
    pub token: Token,
    /// 1-based source line, XS's `node->line`.
    pub line: u32,
    /// The `node->flags` word (see [`flags`]).
    pub flags: u32,
    /// Child slots, in XS's field order (`children[0]` is the
    /// first-pushed / deepest-on-stack slot).
    pub children: Vec<Item>,
    /// Leaf payload for value-bearing nodes.
    pub value: Value,
}

impl Node {
    /// A childless node of `token` at `line` with no flags.
    pub fn leaf(token: Token, line: u32) -> Node {
        Node { token, line, flags: 0, children: Vec::new(), value: Value::None }
    }
}

/// The display name XS gives a node kind (`txNodeDescription.name` in
/// `gxTokenDescriptions`, `xsTree.c`). Used by the fixture dump. Tokens
/// that are never node kinds map to their own debug name; the ones that
/// matter are the node-producing tokens, whose names match XS exactly
/// (including XS's spellings `Exponent`, `PrivateIdenfifier`).
pub fn node_name(token: Token) -> &'static str {
    use Token::*;
    match token {
        Access => "Access",
        Add => "Add",
        AddAssign => "AddAssign",
        And => "And",
        AndAssign => "AndAssign",
        Arg => "Arg",
        Arguments => "Arguments",
        Array => "Array",
        ArrayBinding => "ArrayBinding",
        Assign => "Assign",
        Await => "Await",
        Bigint => "BigInt",
        Binding => "Binding",
        Block => "Block",
        Body => "Body",
        Break => "Break",
        BitAnd => "BitAnd",
        BitAndAssign => "BitAndAssign",
        BitNot => "BitNot",
        BitOr => "BitOr",
        BitOrAssign => "BitOrAssign",
        BitXor => "BitXor",
        BitXorAssign => "BitXorAssign",
        Call => "Call",
        Case => "Case",
        Catch => "Catch",
        Chain => "Chain",
        Class => "Class",
        Coalesce => "Coalesce",
        CoalesceAssign => "CoalesceAssign",
        Const => "Const",
        Continue => "Continue",
        Current => "Current",
        Debugger => "Debugger",
        Decrement => "Decrement",
        Define => "Define",
        Delegate => "Delegate",
        Delete => "Delete",
        Divide => "Divide",
        DivideAssign => "DivideAssign",
        Do => "Do",
        Equal => "Equal",
        Exponentiation => "Exponent",
        ExponentiationAssign => "ExponentAssign",
        Export => "Export",
        Expressions => "Expressions",
        False => "False",
        Field => "Field",
        For => "For",
        ForAwaitOf => "ForAwaitOf",
        ForIn => "ForIn",
        ForOf => "ForOf",
        Function => "Function",
        Generator => "Generator",
        Getter => "Getter",
        Host => "Host",
        If => "If",
        Import => "Import",
        ImportCall => "ImportCall",
        ImportMeta => "ImportMeta",
        In => "In",
        Increment => "Increment",
        Instanceof => "Instanceof",
        Integer => "Integer",
        Items => "Items",
        Label => "Label",
        Let => "Let",
        Member => "Member",
        MemberAt => "MemberAt",
        Minus => "Minus",
        Module => "Module",
        Modulo => "Modulo",
        ModuloAssign => "ModuloAssign",
        More => "More",
        MoreEqual => "MoreEqual",
        Multiply => "Multiply",
        MultiplyAssign => "MultiplyAssign",
        LeftShift => "LeftShift",
        LeftShiftAssign => "LeftShiftAssign",
        Less => "Less",
        LessEqual => "LessEqual",
        New => "New",
        Not => "Not",
        NotEqual => "NotEqual",
        Null => "Null",
        Number => "Number",
        Object => "Object",
        ObjectBinding => "ObjectBinding",
        Option => "Option",
        Or => "Or",
        OrAssign => "OrAssign",
        Params => "Params",
        ParamsBinding => "ParamsBinding",
        Plus => "Plus",
        PrivateIdentifier => "PrivateIdenfifier",
        PrivateMember => "PrivateMember",
        PrivateProperty => "PrivateProperty",
        Program => "Program",
        Property => "Property",
        PropertyAt => "PropertyAt",
        PropertyBinding => "PropertyBinding",
        PropertyBindingAt => "PropertyBindingAt",
        QuestionMark => "QuestionMark",
        Regexp => "Regexp",
        RestBinding => "RestBinding",
        Return => "Return",
        SignedRightShift => "SignedRightShift",
        SignedRightShiftAssign => "SignedRightShiftAssign",
        SkipBinding => "SkipBinding",
        Specifier => "Specifier",
        Spread => "Spread",
        Statement => "Statement",
        Statements => "Statements",
        StrictEqual => "StrictEqual",
        StrictNotEqual => "StrictNotEqual",
        String => "String",
        Subtract => "Subtract",
        SubtractAssign => "SubtractAssign",
        Super => "Super",
        Switch => "Switch",
        Target => "Target",
        Template => "Template",
        TemplateMiddle => "TemplateItem",
        This => "This",
        Throw => "Throw",
        True => "True",
        Try => "Try",
        Typeof => "Typeof",
        Undefined => "Undefined",
        UnsignedRightShift => "UnsignedRightShift",
        UnsignedRightShiftAssign => "UnsignedRightShiftAssign",
        Using => "Using",
        Var => "Var",
        Void => "Void",
        While => "While",
        With => "With",
        Yield => "Yield",
        _ => "?",
    }
}

/// The flag bits worth surfacing in a fixture dump, and their short
/// spellings. Order is deterministic (low bit first).
const DUMP_FLAGS: &[(u32, &str)] = &[
    (flags::STRICT, "strict"),
    (flags::SUPER, "super"),
    (flags::TARGET, "target"),
    (flags::ARGUMENTS, "arguments"),
    (flags::ARROW, "arrow"),
    (flags::ASYNC, "async"),
    (flags::AWAITING, "awaiting"),
    (flags::BASE, "base"),
    (flags::FIELD, "field"),
    (flags::FUNCTION, "function"),
    (flags::DERIVED, "derived"),
    (flags::ELISION, "elision"),
    (flags::EXPRESSION_NO_VALUE, "novalue"),
    (flags::GENERATOR, "generator"),
    (flags::GETTER, "getter"),
    (flags::METHOD, "method"),
    (flags::SETTER, "setter"),
    (flags::SHORTHAND, "shorthand"),
    (flags::SPREAD, "spread"),
    (flags::STATIC, "static"),
];

/// Render a stack item as a stable, one-line-per-node S-expression, the
/// **dump** side of the crate's dump-and-compare fixture tests. The
/// format is ironhorse's own (it is NOT XS's debug `mxTreePrint`, which is
/// not part of the byte-identity bar); it exists to pin the tree *shape*
/// — node kind, flags, child order — that the coder will later depend
/// on. Deterministic and free of addresses so fixtures are stable.
pub fn dump(item: &Item) -> String {
    let mut out = String::new();
    dump_item(item, &mut out);
    out
}

fn dump_item(item: &Item, out: &mut String) {
    match item {
        Item::Null => out.push_str("()"),
        Item::Symbol(s) => {
            out.push_str("#");
            out.push_str(s);
        }
        Item::List(items) => {
            out.push('[');
            for (i, it) in items.iter().enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                dump_item(it, out);
            }
            out.push(']');
        }
        Item::Node(node) => dump_node(node, out),
    }
}

fn dump_node(node: &Node, out: &mut String) {
    out.push('(');
    out.push_str(node_name(node.token));
    for (bit, name) in DUMP_FLAGS {
        if node.flags & bit != 0 {
            out.push(' ');
            out.push(':');
            out.push_str(name);
        }
    }
    match &node.value {
        Value::None => {}
        Value::Integer(v) => {
            out.push_str(" ");
            out.push_str(&v.to_string());
        }
        Value::Number(v) => {
            out.push_str(" ");
            out.push_str(&dump_number(*v));
        }
        Value::Str(s) => {
            out.push_str(" ");
            out.push_str(&dump_string(s));
        }
        Value::BigInt(b) => {
            out.push_str(" ");
            out.push_str(&b.digits);
            out.push_str("n/");
            out.push_str(&b.radix.to_string());
        }
    }
    for child in &node.children {
        out.push(' ');
        dump_item(child, out);
    }
    out.push(')');
}

fn dump_number(v: f64) -> String {
    if v.is_nan() {
        "NaN".to_string()
    } else if v.is_infinite() {
        if v < 0.0 { "-Infinity".to_string() } else { "Infinity".to_string() }
    } else if v == v.trunc() && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

/// Encode a Rust `&str` as UTF-16 code units — the AST/coder string
/// representation. Astral scalars become a surrogate pair, mirroring how
/// XS's CESU-8 storage splits them.
pub fn str_to_units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// Render UTF-16 code units back to a Rust `String` for the text/symbol
/// boundary (property keys, module specifiers, directives). Lone
/// surrogates fold to U+FFFD (`from_utf16_lossy`); every well-formed key —
/// which is all the corpus interns — round-trips exactly.
pub fn units_to_string(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

fn dump_string(units: &[u16]) -> String {
    let s = units_to_string(units);
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}
