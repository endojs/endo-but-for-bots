//! The token model, mirroring `xsScript.h`'s `XS_TOKEN_*` enumeration
//! EXACTLY (design § roadmap row 5). The parser and coder downstream are
//! held to byte-identity against XS, so the lexer must classify each
//! lexeme as the exact token XS would emit and the enum must carry XS's
//! own ordering — the discriminants below are the C `enum` values
//! (`XS_NO_TOKEN = 0`, then the alphabetized `XS_TOKEN_*` list) so a
//! later stage can index token-keyed tables the way XS does.
//!
//! Only a subset of these tokens is produced by the lexer; the rest are
//! AST node kinds the parser and coder synthesize. They are all defined
//! here so the one enum is the shared vocabulary across the pipeline,
//! exactly as `txToken` is the shared type in XS.

/// A token kind. Discriminants equal the C `txToken` enum values at the
/// oracle pin (`c/moddable/xs/sources/xsScript.h`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u16)]
pub enum Token {
    NoToken = 0,
    Access = 1,
    Add = 2,
    AddAssign = 3,
    And = 4,
    AndAssign = 5,
    Arg = 6,
    Arguments = 7,
    ArgumentsSloppy = 8,
    ArgumentsStrict = 9,
    Array = 10,
    ArrayBinding = 11,
    Arrow = 12,
    Assign = 13,
    Await = 14,
    Bigint = 15,
    Binding = 16,
    BitAnd = 17,
    BitAndAssign = 18,
    BitNot = 19,
    BitOr = 20,
    BitOrAssign = 21,
    BitXor = 22,
    BitXorAssign = 23,
    Block = 24,
    Body = 25,
    Break = 26,
    Call = 27,
    Case = 28,
    Catch = 29,
    Chain = 30,
    Class = 31,
    Coalesce = 32,
    CoalesceAssign = 33,
    Colon = 34,
    Comma = 35,
    Const = 36,
    Continue = 37,
    Current = 38,
    Debugger = 39,
    Decrement = 40,
    Default = 41,
    Define = 42,
    Delegate = 43,
    Delete = 44,
    Divide = 45,
    DivideAssign = 46,
    Do = 47,
    Dot = 48,
    Elision = 49,
    Else = 50,
    Enum = 51,
    Eof = 52,
    Equal = 53,
    Eval = 54,
    Exponentiation = 55,
    ExponentiationAssign = 56,
    Export = 57,
    Expressions = 58,
    Extends = 59,
    False = 60,
    Field = 61,
    Finally = 62,
    For = 63,
    ForAwaitOf = 64,
    ForIn = 65,
    ForOf = 66,
    Function = 67,
    Generator = 68,
    Getter = 69,
    Host = 70,
    Identifier = 71,
    If = 72,
    Implements = 73,
    Import = 74,
    ImportCall = 75,
    ImportMeta = 76,
    In = 77,
    Include = 78,
    Increment = 79,
    Instanceof = 80,
    Integer = 81,
    Interface = 82,
    Items = 83,
    Label = 84,
    LeftBrace = 85,
    LeftBracket = 86,
    LeftParenthesis = 87,
    LeftShift = 88,
    LeftShiftAssign = 89,
    Less = 90,
    LessEqual = 91,
    Let = 92,
    Member = 93,
    MemberAt = 94,
    Minus = 95,
    Module = 96,
    Modulo = 97,
    ModuloAssign = 98,
    More = 99,
    MoreEqual = 100,
    Multiply = 101,
    MultiplyAssign = 102,
    New = 103,
    Not = 104,
    NotEqual = 105,
    Null = 106,
    Number = 107,
    Object = 108,
    ObjectBinding = 109,
    Option = 110,
    Or = 111,
    OrAssign = 112,
    Package = 113,
    Params = 114,
    ParamsBinding = 115,
    Plus = 116,
    Private = 117,
    PrivateIdentifier = 118,
    PrivateMember = 119,
    PrivateProperty = 120,
    Program = 121,
    Property = 122,
    PropertyAt = 123,
    PropertyBinding = 124,
    PropertyBindingAt = 125,
    Protected = 126,
    Public = 127,
    QuestionMark = 128,
    Regexp = 129,
    RestBinding = 130,
    Return = 131,
    RightBrace = 132,
    RightBracket = 133,
    RightParenthesis = 134,
    Semicolon = 135,
    Setter = 136,
    Short = 137,
    SignedRightShift = 138,
    SignedRightShiftAssign = 139,
    SkipBinding = 140,
    Specifier = 141,
    Spread = 142,
    Statement = 143,
    Statements = 144,
    Static = 145,
    StrictEqual = 146,
    StrictNotEqual = 147,
    String = 148,
    Subtract = 149,
    SubtractAssign = 150,
    Super = 151,
    Switch = 152,
    Target = 153,
    Template = 154,
    TemplateHead = 155,
    TemplateMiddle = 156,
    TemplateTail = 157,
    This = 158,
    Throw = 159,
    True = 160,
    Try = 161,
    Typeof = 162,
    Undefined = 163,
    UnsignedRightShift = 164,
    UnsignedRightShiftAssign = 165,
    Using = 166,
    Var = 167,
    Void = 168,
    While = 169,
    With = 170,
    Yield = 171,
}

/// XS's `gxTokenNames` (`xsSyntaxical.c`), indexed by token: the spelling
/// its parser errors print (`missing ;`, `invalid token export`).
const XS_TOKEN_NAMES: [&str; 172] = [
    "",                    // XS_NO_TOKEN
    "access",              // XS_TOKEN_ACCESS
    "+",                   // XS_TOKEN_ADD
    "+=",                  // XS_TOKEN_ADD_ASSIGN
    "&&",                  // XS_TOKEN_AND
    "&&=",                 // XS_TOKEN_AND_ASSIGN
    "arg",                 // XS_TOKEN_ARG
    "arguments",           // XS_TOKEN_ARGUMENTS
    "arguments_sloppy",    // XS_TOKEN_ARGUMENTS_SLOPPY
    "arguments_strict",    // XS_TOKEN_ARGUMENTS_STRICT
    "array",               // XS_TOKEN_ARRAY
    "array_binding",       // XS_TOKEN_ARRAY_BINDING
    "=>",                  // XS_TOKEN_ARROW
    "=",                   // XS_TOKEN_ASSIGN
    "await",               // XS_TOKEN_AWAIT
    "bigint",              // XS_TOKEN_BIGINT
    "binding",             // XS_TOKEN_BINDING
    "&",                   // XS_TOKEN_BIT_AND
    "&=",                  // XS_TOKEN_BIT_AND_ASSIGN
    "~",                   // XS_TOKEN_BIT_NOT
    "|",                   // XS_TOKEN_BIT_OR
    "|=",                  // XS_TOKEN_BIT_OR_ASSIGN
    "^",                   // XS_TOKEN_BIT_XOR
    "^=",                  // XS_TOKEN_BIT_XOR_ASSIGN
    "block",               // XS_TOKEN_BLOCK
    "body",                // XS_TOKEN_BODY
    "break",               // XS_TOKEN_BREAK
    "call",                // XS_TOKEN_CALL
    "case",                // XS_TOKEN_CASE
    "catch",               // XS_TOKEN_CATCH
    "?.",                  // XS_TOKEN_CHAIN
    "class",               // XS_TOKEN_CLASS
    "??",                  // XS_TOKEN_COALESCE
    "??=",                 // XS_TOKEN_COALESCE_ASSIGN
    ":",                   // XS_TOKEN_COLON
    ",",                   // XS_TOKEN_COMMA
    "const",               // XS_TOKEN_CONST
    "continue",            // XS_TOKEN_CONTINUE
    "current",             // XS_TOKEN_CURRENT
    "debugger",            // XS_TOKEN_DEBUGGER
    "--",                  // XS_TOKEN_DECREMENT
    "default",             // XS_TOKEN_DEFAULT
    "define",              // XS_TOKEN_DEFINE
    "delegate",            // XS_TOKEN_DELEGATE
    "delete",              // XS_TOKEN_DELETE
    "/",                   // XS_TOKEN_DIVIDE
    "/=",                  // XS_TOKEN_DIVIDE_ASSIGN
    "do",                  // XS_TOKEN_DO
    ".",                   // XS_TOKEN_DOT
    "elision",             // XS_TOKEN_ELISION
    "else",                // XS_TOKEN_ELSE
    "enum",                // XS_TOKEN_ENUM
    "",                    // XS_TOKEN_EOF
    "==",                  // XS_TOKEN_EQUAL
    "eval",                // XS_TOKEN_EVAL
    "**",                  // XS_TOKEN_EXPONENTIATION
    "**=",                 // XS_TOKEN_EXPONENTIATION_ASSIGN
    "export",              // XS_TOKEN_EXPORT
    "expressions",         // XS_TOKEN_EXPRESSIONS
    "extends",             // XS_TOKEN_EXTENDS
    "false",               // XS_TOKEN_FALSE
    "field",               // XS_TOKEN_FIELD
    "finally",             // XS_TOKEN_FINALLY
    "for",                 // XS_TOKEN_FOR
    "for_await_of",        // XS_TOKEN_FOR_AWAIT_OF
    "for_in",              // XS_TOKEN_FOR_IN
    "for_of",              // XS_TOKEN_FOR_OF
    "function",            // XS_TOKEN_FUNCTION
    "generator",           // XS_TOKEN_GENERATOR
    "getter",              // XS_TOKEN_GETTER
    "host",                // XS_TOKEN_HOST
    "identifier",          // XS_TOKEN_IDENTIFIER
    "if",                  // XS_TOKEN_IF
    "implements",          // XS_TOKEN_IMPLEMENTS
    "import",              // XS_TOKEN_IMPORT
    "import",              // XS_TOKEN_IMPORT_CALL
    "import.meta",         // XS_TOKEN_IMPORT_META
    "in",                  // XS_TOKEN_IN
    "include",             // XS_TOKEN_INCLUDE
    "++",                  // XS_TOKEN_INCREMENT
    "instanceof",          // XS_TOKEN_INSTANCEOF
    "integer",             // XS_TOKEN_INTEGER
    "interface",           // XS_TOKEN_INTERFACE
    "items",               // XS_TOKEN_ITEMS
    "label",               // XS_TOKEN_LABEL
    "{",                   // XS_TOKEN_LEFT_BRACE
    "[",                   // XS_TOKEN_LEFT_BRACKET
    "(",                   // XS_TOKEN_LEFT_PARENTHESIS
    "<<",                  // XS_TOKEN_LEFT_SHIFT
    "<<=",                 // XS_TOKEN_LEFT_SHIFT_ASSIGN
    "<",                   // XS_TOKEN_LESS
    "<=",                  // XS_TOKEN_LESS_EQUAL
    "let",                 // XS_TOKEN_LET
    "member",              // XS_TOKEN_MEMBER
    "member_at",           // XS_TOKEN_MEMBER_AT
    "minus",               // XS_TOKEN_MINUS
    "module",              // XS_TOKEN_MODULE
    "%",                   // XS_TOKEN_MODULO
    "%=",                  // XS_TOKEN_MODULO_ASSIGN
    ">",                   // XS_TOKEN_MORE
    ">=",                  // XS_TOKEN_MORE_EQUAL
    "*",                   // XS_TOKEN_MULTIPLY
    "*=",                  // XS_TOKEN_MULTIPLY_ASSIGN
    "new",                 // XS_TOKEN_NEW
    "!",                   // XS_TOKEN_NOT
    "!=",                  // XS_TOKEN_NOT_EQUAL
    "null",                // XS_TOKEN_NULL
    "number",              // XS_TOKEN_NUMBER
    "object",              // XS_TOKEN_OBJECT
    "object_binding",      // XS_TOKEN_OBJECT_BINDING
    "?.",                  // XS_TOKEN_OPTION
    "||",                  // XS_TOKEN_OR
    "||=",                 // XS_TOKEN_OR_ASSIGN
    "package",             // XS_TOKEN_PACKAGE
    "params",              // XS_TOKEN_PARAMS
    "params_binding",      // XS_TOKEN_PARAMS_BINDING
    "plus",                // XS_TOKEN_PLUS
    "private",             // XS_TOKEN_PRIVATE
    "private_identifier",  // XS_TOKEN_PRIVATE_IDENTIFIER
    "private_member",      // XS_TOKEN_PRIVATE_MEMBER
    "private_property",    // XS_TOKEN_PRIVATE_PROPERTY
    "program",             // XS_TOKEN_PROGRAM
    "property",            // XS_TOKEN_PROPERTY
    "property_at",         // XS_TOKEN_PROPERTY_AT
    "property_binding",    // XS_TOKEN_PROPERTY_BINDING
    "property_binding_at", // XS_TOKEN_PROPERTY_BINDING_AT
    "protected",           // XS_TOKEN_PROTECTED
    "public",              // XS_TOKEN_PUBLIC
    "?",                   // XS_TOKEN_QUESTION_MARK
    "regexp",              // XS_TOKEN_REGEXP
    "rest_binding",        // XS_TOKEN_REST_BINDING
    "return",              // XS_TOKEN_RETURN
    "}",                   // XS_TOKEN_RIGHT_BRACE
    "]",                   // XS_TOKEN_RIGHT_BRACKET
    ")",                   // XS_TOKEN_RIGHT_PARENTHESIS
    ";",                   // XS_TOKEN_SEMICOLON
    "setter",              // XS_TOKEN_SETTER
    "short",               // XS_TOKEN_SHORT
    ">>",                  // XS_TOKEN_SIGNED_RIGHT_SHIFT
    ">>=",                 // XS_TOKEN_SIGNED_RIGHT_SHIFT_ASSIGN
    "skip_binding",        // XS_TOKEN_SKIP_BINDING
    "specifier",           // XS_TOKEN_SPECIFIER
    "...",                 // XS_TOKEN_SPREAD
    "statement",           // XS_TOKEN_STATEMENT
    "statements",          // XS_TOKEN_STATEMENTS
    "static",              // XS_TOKEN_STATIC
    "===",                 // XS_TOKEN_STRICT_EQUAL
    "!==",                 // XS_TOKEN_STRICT_NOT_EQUAL
    "string",              // XS_TOKEN_STRING
    "-",                   // XS_TOKEN_SUBTRACT
    "-=",                  // XS_TOKEN_SUBTRACT_ASSIGN
    "super",               // XS_TOKEN_SUPER
    "switch",              // XS_TOKEN_SWITCH
    "target",              // XS_TOKEN_TARGET
    "template",            // XS_TOKEN_TEMPLATE
    "template_head",       // XS_TOKEN_TEMPLATE_HEAD
    "template_middle",     // XS_TOKEN_TEMPLATE_MIDDLE
    "template_tail",       // XS_TOKEN_TEMPLATE_TAIL
    "this",                // XS_TOKEN_THIS
    "throw",               // XS_TOKEN_THROW
    "true",                // XS_TOKEN_TRUE
    "try",                 // XS_TOKEN_TRY
    "typeof",              // XS_TOKEN_TYPEOF
    "undefined",           // XS_TOKEN_UNDEFINED
    ">>>",                 // XS_TOKEN_UNSIGNED_RIGHT_SHIFT
    ">>>=",                // XS_TOKEN_UNSIGNED_RIGHT_SHIFT_ASSIGN
    "using",               // XS_TOKEN_USIGN
    "var",                 // XS_TOKEN_VAR
    "void",                // XS_TOKEN_VOID
    "while",               // XS_TOKEN_WHILE
    "with",                // XS_TOKEN_WITH
    "yield",               // XS_TOKEN_YIELD
];

impl Token {
    /// The spelling XS's parser errors give this token (`gxTokenNames`).
    pub fn xs_name(self) -> &'static str {
        XS_TOKEN_NAMES[self as usize]
    }

    /// The XS enum ordinal (`txToken` value). Stable across the port so
    /// downstream token-keyed tables match XS byte for byte.
    #[inline]
    pub fn ordinal(self) -> u16 {
        self as u16
    }
}

/// A reserved word recognized in every mode, mapped to its token. Mirrors
/// `gxKeywords` in `xsLexical.c` (kept sorted; XS binary-searches it).
pub static KEYWORDS: &[(&str, Token)] = &[
    ("break", Token::Break),
    ("case", Token::Case),
    ("catch", Token::Catch),
    ("class", Token::Class),
    ("const", Token::Const),
    ("continue", Token::Continue),
    ("debugger", Token::Debugger),
    ("default", Token::Default),
    ("delete", Token::Delete),
    ("do", Token::Do),
    ("else", Token::Else),
    ("enum", Token::Enum),
    ("export", Token::Export),
    ("extends", Token::Extends),
    ("false", Token::False),
    ("finally", Token::Finally),
    ("for", Token::For),
    ("function", Token::Function),
    ("if", Token::If),
    ("import", Token::Import),
    ("in", Token::In),
    ("instanceof", Token::Instanceof),
    ("new", Token::New),
    ("null", Token::Null),
    ("return", Token::Return),
    ("super", Token::Super),
    ("switch", Token::Switch),
    ("this", Token::This),
    ("throw", Token::Throw),
    ("true", Token::True),
    ("try", Token::Try),
    ("typeof", Token::Typeof),
    ("var", Token::Var),
    ("void", Token::Void),
    ("while", Token::While),
    ("with", Token::With),
];

/// Reserved words recognized only in strict mode. Mirrors
/// `gxStrictKeywords` in `xsLexical.c`.
pub static STRICT_KEYWORDS: &[(&str, Token)] = &[
    ("implements", Token::Implements),
    ("interface", Token::Interface),
    ("let", Token::Let),
    ("package", Token::Package),
    ("private", Token::Private),
    ("protected", Token::Protected),
    ("public", Token::Public),
    ("static", Token::Static),
    ("yield", Token::Yield),
];

/// Look up `word` as a keyword the way XS's `fxGetNextKeyword` does: the
/// always-reserved set first, then the strict-only set when `strict`,
/// then the contextual `await`/`yield`. Returns [`Token::Identifier`]
/// when the word is not a keyword in this context.
///
/// `async_ctx`/`generator_ctx` gate the contextual keywords exactly as
/// the `mxAsyncFlag`/`mxGeneratorFlag` checks do in XS.
pub fn classify_word(word: &str, strict: bool, async_ctx: bool, generator_ctx: bool) -> Token {
    if let Ok(i) = KEYWORDS.binary_search_by(|(k, _)| (*k).cmp(word)) {
        return KEYWORDS[i].1;
    }
    if strict {
        if let Ok(i) = STRICT_KEYWORDS.binary_search_by(|(k, _)| (*k).cmp(word)) {
            return STRICT_KEYWORDS[i].1;
        }
    }
    if async_ctx && word == "await" {
        return Token::Await;
    }
    if generator_ctx && word == "yield" {
        return Token::Yield;
    }
    Token::Identifier
}
