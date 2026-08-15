//! Regenerate the vendored RegExp-v properties-of-strings tables from the
//! repository's pinned Moddable XS source.

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

const XSRE_FNV1A64: u64 = 0xc521_6796_6a1f_c1e7;
const PROPERTY_NAMES: [&str; 7] = [
    "Basic_Emoji",
    "Emoji_Keycap_Sequence",
    "RGI_Emoji",
    "RGI_Emoji_Flag_Sequence",
    "RGI_Emoji_Modifier_Sequence",
    "RGI_Emoji_Tag_Sequence",
    "RGI_Emoji_ZWJ_Sequence",
];

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3)
    })
}

fn array_body<'a>(source: &'a str, marker: &str) -> &'a str {
    source
        .split_once(marker)
        .unwrap_or_else(|| panic!("missing {marker}"))
        .1
        .split_once("\n};")
        .unwrap_or_else(|| panic!("unterminated {marker}"))
        .0
}

fn character_endpoints(source: &str, name: &str) -> Vec<i32> {
    let marker = format!("gxCharSet_{name}[mxCharSet_{name}] = {{");
    if !source.contains(&marker) {
        let null_marker = format!("#define gxCharSet_{name} C_NULL");
        assert!(source.contains(&null_marker), "missing {marker}");
        return Vec::new();
    }
    array_body(source, &marker)
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(|token| {
            i32::from_str_radix(
                token
                    .strip_prefix("0x")
                    .expect("XS endpoint is hexadecimal"),
                16,
            )
            .expect("valid XS endpoint")
        })
        .collect()
}

fn strings(source: &str, name: &str) -> Vec<String> {
    let marker = format!("gxStrings_{name}[mxStrings_{name}] = {{");
    let body = array_body(source, &marker).as_bytes();
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < body.len() {
        if body[offset] != b'\"' {
            offset += 1;
            continue;
        }
        offset += 1;
        let mut bytes = Vec::new();
        while body[offset] != b'\"' {
            if body[offset] == b'\\' {
                assert_eq!(body[offset + 1], b'x', "XS strings use hex escapes");
                let hex = std::str::from_utf8(&body[offset + 2..offset + 4]).unwrap();
                bytes.push(u8::from_str_radix(hex, 16).expect("valid XS string byte"));
                offset += 4;
            } else {
                bytes.push(body[offset]);
                offset += 1;
            }
        }
        offset += 1;
        result.push(String::from_utf8(bytes).expect("XS property string is UTF-8"));
    }
    result
}

fn rust_string(value: &str) -> String {
    let mut result = String::from("\"");
    for character in value.chars() {
        match character {
            '\\' => result.push_str("\\\\"),
            '\"' => result.push_str("\\\""),
            ' '..='~' => result.push(character),
            _ => write!(result, "\\u{{{:x}}}", u32::from(character)).unwrap(),
        }
    }
    result.push('\"');
    result
}

fn rust_name(name: &str) -> String {
    let mut result = String::new();
    for (index, character) in name.chars().enumerate() {
        if character.is_ascii_uppercase() && index != 0 {
            result.push('_');
        }
        result.push(character.to_ascii_uppercase());
    }
    result
}

fn main() {
    let source_path = Path::new("../../../c/moddable/xs/sources/xsre.c");
    let bytes = fs::read(source_path).expect("read pinned Moddable xsre.c");
    assert_eq!(fnv1a64(&bytes), XSRE_FNV1A64, "unexpected Moddable pin");
    let source = std::str::from_utf8(&bytes).expect("xsre.c is UTF-8");
    let mut generated = String::from(
        "// Generated from Moddable XS 23b4d6b0a65f35209d9118c4c13c6c9b3e68784d xsre.c.\n\
         // Source FNV-1a 64: c52167966a1fc1e7. Do not edit by hand.\n\n",
    );
    for name in PROPERTY_NAMES {
        let rust_name = rust_name(name);
        writeln!(
            generated,
            "static STRING_PROPERTY_{rust_name}_CHARACTERS: &[i32] = &["
        )
        .unwrap();
        for chunk in character_endpoints(source, name).chunks(12) {
            generated.push_str("    ");
            for (index, value) in chunk.iter().enumerate() {
                if index != 0 {
                    generated.push(' ');
                }
                write!(generated, "0x{value:x},").unwrap();
            }
            generated.push('\n');
        }
        generated.push_str("];\n\n");
        writeln!(
            generated,
            "static STRING_PROPERTY_{rust_name}_STRINGS: &[&str] = &["
        )
        .unwrap();
        for value in strings(source, name) {
            writeln!(generated, "    {},", rust_string(&value)).unwrap();
        }
        generated.push_str("];\n\n");
    }
    generated.push_str(
        "pub(super) fn lookup_string_property(name: &str) -> Option<(&'static [i32], &'static [&'static str])> {\n\
             match name {\n",
    );
    for name in PROPERTY_NAMES {
        let rust_name = rust_name(name);
        writeln!(
            generated,
            "        {name:?} => Some((STRING_PROPERTY_{rust_name}_CHARACTERS, STRING_PROPERTY_{rust_name}_STRINGS)),"
        )
        .unwrap();
    }
    generated.push_str("        _ => None,\n    }\n}\n");
    fs::write("src/unicode_string_properties_generated.rs", generated)
        .expect("write vendored string-property tables");
}
