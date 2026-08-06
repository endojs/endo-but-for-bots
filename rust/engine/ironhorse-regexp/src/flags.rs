//! The `XS_REGEXP_*` flag bits (`xsCommon.h`), the compiled pattern's
//! `code[0]`.

pub const XS_REGEXP_G: u32 = 1 << 0;
pub const XS_REGEXP_I: u32 = 1 << 1;
pub const XS_REGEXP_M: u32 = 1 << 2;
pub const XS_REGEXP_N: u32 = 1 << 3;
pub const XS_REGEXP_S: u32 = 1 << 4;
pub const XS_REGEXP_U: u32 = 1 << 5;
pub const XS_REGEXP_Y: u32 = 1 << 6;
pub const XS_REGEXP_D: u32 = 1 << 7;
pub const XS_REGEXP_V: u32 = 1 << 8;
/// Transient bit set while parsing a group `<name>`: it makes the pattern
/// lexer deliver an astral code point as a whole scalar (rather than the
/// non-`UV` surrogate split), so the name's `ID_Start`/`ID_Continue` check
/// sees the real code point.
pub const XS_REGEXP_NAME: u32 = 1 << 9;

/// The character-set combine ops (`xsre.c` enum).
pub const MX_CHARSET_UNION_OP: i32 = 0;
#[allow(dead_code)]
pub const MX_CHARSET_SUBTRACT_OP: i32 = 1;
#[allow(dead_code)]
pub const MX_CHARSET_INTERSECTION_OP: i32 = 3;
