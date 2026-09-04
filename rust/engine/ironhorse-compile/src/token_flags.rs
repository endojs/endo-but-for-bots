//! The per-token grammar-class bitset, a transliteration of
//! `gxTokenFlags` in `xsSyntaxical.c` at the oracle pin. The expression
//! grammar consults it constantly (`gxTokenFlags[token] & XS_TOKEN_…`)
//! to decide, e.g., whether a token can begin an expression or continue
//! a binary ladder. Indexed by [`Token`] ordinal; the array order is
//! XS's own token order so the two tables stay in lockstep.

use crate::token::Token;

pub const BEGIN_STATEMENT: u32 = 1;
pub const BEGIN_EXPRESSION: u32 = 2;
pub const ASSIGN_EXPRESSION: u32 = 4;
pub const EQUAL_EXPRESSION: u32 = 8;
pub const RELATIONAL_EXPRESSION: u32 = 16;
pub const SHIFT_EXPRESSION: u32 = 32;
pub const ADDITIVE_EXPRESSION: u32 = 64;
pub const MULTIPLICATIVE_EXPRESSION: u32 = 128;
pub const EXPONENTIATION_EXPRESSION: u32 = 256;
pub const PREFIX_EXPRESSION: u32 = 512;
pub const POSTFIX_EXPRESSION: u32 = 1024;
pub const END_STATEMENT: u32 = 2048;
pub const REFERENCE_EXPRESSION: u32 = 4096;
pub const BEGIN_BINDING: u32 = 16384;
pub const IDENTIFIER_NAME: u32 = 32768;
pub const UNARY_EXPRESSION: u32 = 65536;
pub const CALL_EXPRESSION: u32 = 131072;

// Shorthands for the table below, kept terse so it reads like the C.
const BS: u32 = BEGIN_STATEMENT;
const BE: u32 = BEGIN_EXPRESSION;
const AS: u32 = ASSIGN_EXPRESSION;
const EQ: u32 = EQUAL_EXPRESSION;
const RE: u32 = RELATIONAL_EXPRESSION;
const SH: u32 = SHIFT_EXPRESSION;
const AD: u32 = ADDITIVE_EXPRESSION;
const ML: u32 = MULTIPLICATIVE_EXPRESSION;
const EX: u32 = EXPONENTIATION_EXPRESSION;
const PRE: u32 = PREFIX_EXPRESSION;
const PO: u32 = POSTFIX_EXPRESSION;
const ES: u32 = END_STATEMENT;
const BB: u32 = BEGIN_BINDING;
const IN: u32 = IDENTIFIER_NAME;
const UN: u32 = UNARY_EXPRESSION;
const CA: u32 = CALL_EXPRESSION;

/// `gxTokenFlags`, one entry per token in ordinal order.
static TOKEN_FLAGS: [u32; 172] = [
    /* NoToken */ 0,
    /* Access */ 0,
    /* Add */ BS | BE | AD | UN,
    /* AddAssign */ AS,
    /* And */ 0,
    /* AndAssign */ AS,
    /* Arg */ 0,
    /* Arguments */ 0,
    /* ArgumentsSloppy */ 0,
    /* ArgumentsStrict */ 0,
    /* Array */ 0,
    /* ArrayBinding */ 0,
    /* Arrow */ 0,
    /* Assign */ AS,
    /* Await */ BS | BE | UN | IN,
    /* Bigint */ BS | BE,
    /* Binding */ 0,
    /* BitAnd */ 0,
    /* BitAndAssign */ AS,
    /* BitNot */ BS | BE | UN,
    /* BitOr */ 0,
    /* BitOrAssign */ AS,
    /* BitXor */ 0,
    /* BitXorAssign */ AS,
    /* Block */ 0,
    /* Body */ 0,
    /* Break */ BS | IN,
    /* Call */ 0,
    /* Case */ IN,
    /* Catch */ IN,
    /* Chain */ CA,
    /* Class */ BS | BE | IN,
    /* Coalesce */ 0,
    /* CoalesceAssign */ AS,
    /* Colon */ 0,
    /* Comma */ ES,
    /* Const */ BS | IN,
    /* Continue */ BS | IN,
    /* Current */ 0,
    /* Debugger */ BS | IN,
    /* Decrement */ BS | BE | PRE | PO,
    /* Default */ IN,
    /* Define */ 0,
    /* Delegate */ 0,
    /* Delete */ BS | BE | UN | IN,
    /* Divide */ BE | ML,
    /* DivideAssign */ BE | AS,
    /* Do */ BS | IN,
    /* Dot */ CA,
    /* Elision */ 0,
    /* Else */ IN,
    /* Enum */ IN,
    /* Eof */ ES,
    /* Equal */ EQ,
    /* Eval */ 0,
    /* Exponentiation */ EX,
    /* ExponentiationAssign */ AS,
    /* Export */ IN,
    /* Expressions */ 0,
    /* Extends */ IN,
    /* False */ BS | BE | IN,
    /* Field */ 0,
    /* Finally */ IN,
    /* For */ BS | IN,
    /* ForAwaitOf */ 0,
    /* ForIn */ 0,
    /* ForOf */ 0,
    /* Function */ BS | BE | IN,
    /* Generator */ 0,
    /* Getter */ 0,
    /* Host */ BE,
    /* Identifier */ BS | BE | BB | IN,
    /* If */ BS | IN,
    /* Implements */ IN,
    /* Import */ BE | IN,
    /* ImportCall */ 0,
    /* ImportMeta */ 0,
    /* In */ RE | IN,
    /* Include */ 0,
    /* Increment */ BS | BE | PRE | PO,
    /* Instanceof */ RE | IN,
    /* Integer */ BS | BE,
    /* Interface */ IN,
    /* Items */ 0,
    /* Label */ 0,
    /* LeftBrace */ BS | BE | BB,
    /* LeftBracket */ BS | BE | BB | CA,
    /* LeftParenthesis */ BS | BE | CA,
    /* LeftShift */ SH,
    /* LeftShiftAssign */ AS,
    /* Less */ BE | RE,
    /* LessEqual */ RE,
    /* Let */ BS | IN,
    /* Member */ 0,
    /* MemberAt */ 0,
    /* Minus */ 0,
    /* Module */ 0,
    /* Modulo */ ML,
    /* ModuloAssign */ AS,
    /* More */ RE,
    /* MoreEqual */ RE,
    /* Multiply */ ML,
    /* MultiplyAssign */ AS,
    /* New */ BS | BE | IN,
    /* Not */ BS | BE | UN,
    /* NotEqual */ EQ,
    /* Null */ BS | BE | IN,
    /* Number */ BS | BE,
    /* Object */ 0,
    /* ObjectBinding */ 0,
    /* Option */ 0,
    /* Or */ 0,
    /* OrAssign */ AS,
    /* Package */ IN,
    /* Params */ 0,
    /* ParamsBinding */ 0,
    /* Plus */ 0,
    /* Private */ IN,
    /* PrivateIdentifier */ BE,
    /* PrivateMember */ 0,
    /* PrivateProperty */ 0,
    /* Program */ 0,
    /* Property */ 0,
    /* PropertyAt */ 0,
    /* PropertyBinding */ 0,
    /* PropertyBindingAt */ 0,
    /* Protected */ IN,
    /* Public */ IN,
    /* QuestionMark */ 0,
    /* Regexp */ BS | BE,
    /* RestBinding */ 0,
    /* Return */ BS | IN,
    /* RightBrace */ ES,
    /* RightBracket */ 0,
    /* RightParenthesis */ 0,
    /* Semicolon */ BS | ES,
    /* Setter */ 0,
    /* Short */ 0,
    /* SignedRightShift */ SH,
    /* SignedRightShiftAssign */ AS,
    /* SkipBinding */ 0,
    /* Specifier */ 0,
    /* Spread */ BB,
    /* Statement */ 0,
    /* Statements */ 0,
    /* Static */ IN,
    /* StrictEqual */ EQ,
    /* StrictNotEqual */ EQ,
    /* String */ BS | BE,
    /* Subtract */ BS | BE | AD | UN,
    /* SubtractAssign */ AS,
    /* Super */ BS | BE | IN,
    /* Switch */ BS | IN,
    /* Target */ 0,
    /* Template */ BS | BE | CA,
    /* TemplateHead */ BS | BE | CA,
    /* TemplateMiddle */ 0,
    /* TemplateTail */ 0,
    /* This */ BS | BE | IN,
    /* Throw */ BS | IN,
    /* True */ BS | BE | IN,
    /* Try */ BS | IN,
    /* Typeof */ BS | BE | UN | IN,
    /* Undefined */ 0,
    /* UnsignedRightShift */ SH,
    /* UnsignedRightShiftAssign */ AS,
    /* Using */ BS | IN,
    /* Var */ BS | IN,
    /* Void */ BS | BE | UN | IN,
    /* While */ BS | IN,
    /* With */ BS | IN,
    /* Yield */ BS | BE | IN,
];

/// The grammar-class bitset for `token` (`gxTokenFlags[token]`).
#[inline]
pub fn token_flags(token: Token) -> u32 {
    TOKEN_FLAGS[token as usize]
}

/// `gxTokenFlags[token] & mask != 0`.
#[inline]
pub fn has_flag(token: Token, mask: u32) -> bool {
    token_flags(token) & mask != 0
}
