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

impl Token {
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
