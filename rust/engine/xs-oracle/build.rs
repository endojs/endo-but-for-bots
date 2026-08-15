//! Build the XS oracle: compile the c/moddable XS engine (the pin
//! the endor daemon builds today) with the same feature defines as
//! the xsnap crate, plus the xs_shim.c bridge, into one static
//! library. This is the only place the engine workspace touches C.
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

    // Exactly the source set and flags xsnap uses, so the oracle's
    // XS is bit-identical to the engine ironhorse replaces.
    let sources = [
        "xsAll.c", "xsAPI.c", "xsArguments.c", "xsArray.c", "xsAtomics.c",
        "xsBigInt.c", "xsBoolean.c", "xsCode.c", "xsCommon.c", "xsDataView.c",
        "xsDate.c", "xsDebug.c", "xsDefaults.c", "xsdtoa.c", "xsError.c",
        "xsFunction.c", "xsGenerator.c", "xsGlobal.c", "xsJSON.c", "xsLexical.c",
        "xsLockdown.c", "xsMapSet.c", "xsMarshall.c", "xsMath.c", "xsMemory.c",
        "xsModule.c", "xsNumber.c", "xsObject.c", "xsPlatforms.c", "xsProfile.c",
        "xsPromise.c", "xsProperty.c", "xsProxy.c", "xsre.c", "xsRegExp.c",
        "xsRun.c", "xsScope.c", "xsScript.c", "xsSnapshot.c", "xsSourceMap.c",
        "xsString.c", "xsSymbol.c", "xsSyntaxical.c", "xsTree.c", "xsType.c",
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
        .flag("-Wno-misleading-indentation")
        .flag("-Wno-implicit-fallthrough")
        .flag("-Wno-unused-parameter")
        .flag("-Wno-sign-compare")
        .flag("-Wno-unused-variable")
        .opt_level(2);

    for source in &sources {
        build.file(xs_sources.join(source));
    }
    build.file(&platform_source);
    build.file(manifest_dir.join("csrc/xs_shim.c"));
    build.compile("xsoracle");

    println!("cargo:rerun-if-changed=csrc/xs_shim.c");
    println!("cargo:rerun-if-changed=csrc/xsoracle-platform.h");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", platform_source.display());
    println!("cargo:rustc-link-lib=m");
    println!("cargo:rustc-link-lib=pthread");
    println!("cargo:rustc-link-lib=dl");
}
