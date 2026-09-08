//! Build the XS oracle: compile the c/moddable XS engine (the pin
//! the endor daemon builds today) with the same feature defines as
//! the xsnap crate, plus the xs_shim.c bridge, into one static
//! library, with the checked parser-diagnostic overlay below. This is the
//! only place the engine workspace touches C.
//!
//! We deliberately compile libxs here rather than depending on the
//! xsnap crate as a Cargo path dependency: xsnap's lib.rs includes
//! generated SES bundles (ses_boot.js, worker_bootstrap.js,
//! daemon_bootstrap.js) that are gitignored build artifacts and are
//! absent from a fresh checkout, so `xsnap` does not compile
//! stand-alone here. The oracle only needs libxs + a compile/run
//! bridge, so it links the same C sources directly and reuses
//! xsnap's audited platform layer (xsnap-platform.{c,h}) verbatim.

use std::env;
use std::path::PathBuf;

// Retain the upstream source suffix so the existing upstream-only UBSAN
// ignorelist applies to this checked copy. ASAN remains enabled, and neither
// xs_shim.c nor xsnap-platform.c moves under this path. The sanitizer scope
// regression reads this constant to probe the actual generated source path.
const LEXICAL_OVERLAY_PATH: &str = "c/moddable/xs/sources/xsLexical.c";

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // rust/engine/xs-oracle -> repo root is three levels up.
    let repo_root = manifest_dir.join("../../..");
    let moddable_dir = repo_root.join("c/moddable");
    let xs_sources = moddable_dir.join("xs/sources");
    let xs_includes = moddable_dir.join("xs/includes");
    let xs_platforms = moddable_dir.join("xs/platforms");
    let xsnap_dir = repo_root.join("rust/endo/xsnap");
    // The oracle links xsnap's platform verbatim but through a thin wrapper
    // header that disables the archive-only default module loader, so the
    // executable-module entry can use the shim's filesystem resolve/load
    // hooks (see csrc/xsoracle-platform.h).
    let platform_header = manifest_dir.join("csrc/xsoracle-platform.h");
    let platform_source = xsnap_dir.join("xsnap-platform.c");

    if !xs_sources.join("xsAll.c").exists() {
        panic!(
            "Moddable XS sources not found at {}. Run \
             `git submodule update --init c/moddable` from the repo \
             root (pin 23b4d6b0a65f = moddable 8.3.1, per the design's \
             Ground Truth; see rust/engine/README.md § Building the oracle).",
            xs_sources.display()
        );
    }

    // The source set and feature flags match xsnap. One checked lexical
    // diagnostic overlay below removes platform-dependent undefined behavior.
    let sources = [
        "xsAll.c",
        "xsAPI.c",
        "xsArguments.c",
        "xsArray.c",
        "xsAtomics.c",
        "xsBigInt.c",
        "xsBoolean.c",
        "xsCode.c",
        "xsCommon.c",
        "xsDataView.c",
        "xsDate.c",
        "xsDebug.c",
        "xsDefaults.c",
        "xsdtoa.c",
        "xsError.c",
        "xsFunction.c",
        "xsGenerator.c",
        "xsGlobal.c",
        "xsJSON.c",
        "xsLexical.c",
        "xsLockdown.c",
        "xsMapSet.c",
        "xsMarshall.c",
        "xsMath.c",
        "xsMemory.c",
        "xsModule.c",
        "xsNumber.c",
        "xsObject.c",
        "xsPlatforms.c",
        "xsProfile.c",
        "xsPromise.c",
        "xsProperty.c",
        "xsProxy.c",
        "xsre.c",
        "xsRegExp.c",
        "xsRun.c",
        "xsScope.c",
        "xsScript.c",
        "xsSnapshot.c",
        "xsSourceMap.c",
        "xsString.c",
        "xsSymbol.c",
        "xsSyntaxical.c",
        "xsTree.c",
        "xsType.c",
    ];

    let mut build = cc::Build::new();
    build
        .include(&xs_sources)
        .include(&xs_includes)
        .include(&xs_platforms)
        .include(&xsnap_dir)
        .include(manifest_dir.join("csrc"))
        .define(
            "XSPLATFORM",
            Some(format!("\"{}\"", platform_header.display()).as_str()),
        )
        .define("INCLUDE_XSPLATFORM", None)
        .define("mxLockdown", Some("1"))
        .define("mxMetering", Some("1"))
        .define("mxParse", Some("1"))
        .define("mxRun", Some("1"))
        .define("mxSloppy", Some("1"))
        .define("mxSnapshot", Some("1"))
        .define("mxRegExpUnicodePropertyEscapes", Some("1"))
        .define("mxStringNormalize", Some("1"))
        .define("mxMinusZero", Some("1"))
        .define("mxBoundsCheck", Some("1"))
        .define("mxModuleStuff", Some("1"))
        .define("mxCanonicalNaN", Some("1"))
        .define("mxCESU8", Some("1"))
        .define("mxStringInfoCacheLength", Some("4"))
        .flag("-fno-common")
        // XS reads Number storage through integer pointers (for example,
        // fxSumEntry hashes a NaN immediately after canonicalizing it).
        // Preserve those aliasing accesses under optimized GCC builds.
        .flag("-fno-strict-aliasing")
        .flag("-Wno-misleading-indentation")
        .flag("-Wno-implicit-fallthrough")
        .flag("-Wno-unused-parameter")
        .flag("-Wno-sign-compare")
        .flag("-Wno-unused-variable")
        .opt_level(2);

    // xsLexical.c passes parser->buffer as the `%s` argument to
    // fxReportParserError, which formats back into that same buffer. Overlapping
    // snprintf input/output is undefined: glibc loses the message while Darwin
    // retains it. Copy into parser-owned storage before the formatter runs.
    // Keep the pinned submodule untouched and fail closed if its call changes.
    let lexical_path = xs_sources.join("xsLexical.c");
    let lexical = std::fs::read_to_string(&lexical_path).expect("read pinned xsLexical.c");
    let old = "fxReportParserError(parser, parser->states[0].line, \"%s\", parser->buffer);";
    let new = "fxReportParserError(parser, parser->states[0].line, \"%s\", fxNewParserString(parser, parser->buffer, mxStringLength(parser->buffer)));";
    assert_eq!(
        lexical.matches(old).count(),
        1,
        "pinned XS RegExp diagnostic call changed; review the lexical overlay"
    );
    let lexical_overlay =
        PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR")).join(LEXICAL_OVERLAY_PATH);
    std::fs::create_dir_all(lexical_overlay.parent().expect("lexical overlay parent"))
        .expect("create checked upstream overlay directory");
    std::fs::write(&lexical_overlay, lexical.replacen(old, new, 1))
        .expect("write checked xsLexical.c overlay");
    // Its only include is xsScript.h, resolved through xs_sources above.
    for source in &sources {
        if *source == "xsLexical.c" {
            build.file(&lexical_overlay);
        } else {
            build.file(xs_sources.join(source));
        }
    }
    println!("cargo:rerun-if-changed={}", lexical_path.display());
    build.file(&platform_source);
    build.file(manifest_dir.join("csrc/xs_shim.c"));
    build.compile("xsoracle");

    println!("cargo:rerun-if-changed=csrc/xs_shim.c");
    println!("cargo:rerun-if-changed=csrc/xsoracle-platform.h");
    println!("cargo:rerun-if-changed=build.rs");
    // CFLAGS carries the ignorelist path, so track its contents as well. A
    // changed exclusion must rebuild the C objects, including in cached CI.
    println!("cargo:rerun-if-changed=../scripts/oracle-sanitizer-ignorelist.txt");
    println!("cargo:rerun-if-changed={}", platform_source.display());
    println!("cargo:rustc-link-lib=m");
    println!("cargo:rustc-link-lib=pthread");
    println!("cargo:rustc-link-lib=dl");
}
