use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::PathBuf;

const XSRE_FNV1A64: u64 = 0xc521_6796_6a1f_c1e7;

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3)
    })
}

fn registry(source: &str, table: &str) -> Vec<(String, String)> {
    let marker = format!("gxCharSet_{table}[mxCharSet_{table}] = {{");
    let body = source
        .split_once(&marker)
        .unwrap_or_else(|| panic!("missing XS unicode-property registry {table}"))
        .1
        .split_once("\n};")
        .unwrap_or_else(|| panic!("unterminated XS unicode-property registry {table}"))
        .0;
    body.lines()
        .filter_map(|line| {
            let line = line.trim();
            if !line.starts_with("{ \"") {
                return None;
            }
            let rest = &line[3..];
            let (alias, rest) = rest.split_once('"').expect("property alias terminator");
            let data = rest
                .split(',')
                .nth(2)
                .expect("property data field")
                .trim()
                .trim_end_matches(',')
                .trim_end_matches('}')
                .trim();
            Some((alias.to_owned(), data.to_owned()))
        })
        .collect()
}

fn arrays(source: &str, wanted: &BTreeSet<String>) -> BTreeMap<String, Vec<i32>> {
    let mut result = BTreeMap::new();
    let mut lines = source.lines();
    while let Some(line) = lines.next() {
        let Some(start) = line.find("gxCharSet_") else {
            continue;
        };
        if !line.starts_with("static const txInteger") || !line.ends_with(" = {") {
            continue;
        }
        let name = line[start..]
            .split('[')
            .next()
            .expect("charset array name")
            .to_owned();
        let mut values = Vec::new();
        for values_line in lines.by_ref() {
            if values_line.trim() == "};" {
                break;
            }
            for token in values_line
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let value = i32::from_str_radix(
                    token
                        .strip_prefix("0x")
                        .expect("XS charset endpoint is hexadecimal"),
                    16,
                )
                .expect("valid XS charset endpoint");
                values.push(value);
            }
        }
        if wanted.contains(&name) {
            result.insert(name, values);
        }
    }
    result
}

fn rust_name(xs_name: &str) -> String {
    xs_name
        .strip_prefix("gxCharSet_")
        .expect("XS charset prefix")
        .to_ascii_uppercase()
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let xsre = manifest.join("../../../c/moddable/xs/sources/xsre.c");
    println!("cargo:rerun-if-changed={}", xsre.display());
    let bytes = fs::read(&xsre).expect("read pinned Moddable xsre.c");
    let actual = fnv1a64(&bytes);
    assert_eq!(
        actual, XSRE_FNV1A64,
        "Moddable xsre.c changed: update the pin and audit the generated Unicode property tables"
    );
    let source = std::str::from_utf8(&bytes).expect("xsre.c is UTF-8");
    let registries = [
        ("Binary_Property", "binary"),
        ("General_Category", "general_category"),
        ("Script", "script"),
        ("Script_Extensions", "script_extensions"),
    ];
    let parsed: Vec<_> = registries
        .iter()
        .map(|(xs, rust)| (*rust, registry(source, xs)))
        .collect();
    let wanted: BTreeSet<_> = parsed
        .iter()
        .flat_map(|(_, entries)| entries.iter().map(|(_, array)| array.clone()))
        .collect();
    let data = arrays(source, &wanted);
    assert_eq!(
        data.len(),
        wanted.len(),
        "not every referenced XS charset array was found"
    );

    let mut generated = String::from(
        "// Generated at build time from the repository's pinned Moddable xsre.c.\n\
         // Do not edit: build.rs verifies the complete source file before extracting tables.\n\n",
    );
    for (name, values) in &data {
        generated.push_str(&format!("static {}: &[i32] = &[", rust_name(name)));
        for (index, value) in values.iter().enumerate() {
            if index % 12 == 0 {
                generated.push_str("\n    ");
            }
            generated.push_str(&format!("0x{value:x}, "));
        }
        generated.push_str("\n];\n\n");
    }
    for (function, entries) in parsed {
        generated.push_str(&format!("pub(super) fn lookup_{function}(name: &str) -> Option<&'static [i32]> {{\n    match name {{\n"));
        for (alias, array) in entries {
            generated.push_str(&format!(
                "        {alias:?} => Some({}),\n",
                rust_name(&array)
            ));
        }
        generated.push_str("        _ => None,\n    }\n}\n\n");
    }
    let output =
        PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("unicode_properties.rs");
    fs::write(output, generated).expect("write generated Unicode property tables");
}
