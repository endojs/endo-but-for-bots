//! ECMAScript Unicode property aliases and endpoint sets extracted from the
//! the repository's pinned Moddable XS `xsre.c`.

include!("unicode_properties_generated.rs");
include!("unicode_string_properties_generated.rs");

pub(crate) fn lookup(name: &str, value: Option<&str>) -> Option<&'static [i32]> {
    match value {
        Some(value) => match name {
            "General_Category" | "gc" => lookup_general_category(value),
            "Script" | "sc" => lookup_script(value),
            "Script_Extensions" | "scx" => lookup_script_extensions(value),
            _ => None,
        },
        None => lookup_general_category(name).or_else(|| lookup_binary(name)),
    }
}
