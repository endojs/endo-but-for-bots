//! ECMAScript Unicode property aliases and endpoint sets extracted from the
//! repository's pinned Moddable XS `xsre.c` by `build.rs`.

include!(concat!(env!("OUT_DIR"), "/unicode_properties.rs"));

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

pub(crate) fn is_v_string_property(name: &str) -> bool {
    matches!(
        name,
        "Basic_Emoji"
            | "Emoji_Keycap_Sequence"
            | "RGI_Emoji"
            | "RGI_Emoji_Flag_Sequence"
            | "RGI_Emoji_Modifier_Sequence"
            | "RGI_Emoji_Tag_Sequence"
            | "RGI_Emoji_ZWJ_Sequence"
    )
}
