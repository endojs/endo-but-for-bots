//! How far the SES *shim* profile carries Ironhorse through the repo's
//! `ses-xs-parity` corpus — the third host of the axis
//! `packages/test262-runner` runs against `xst` and node.
//!
//! The axis's Ironhorse host (`scripts/run-ironhorse-host.js`) drives
//! `endot-ih -l`, which expects an ENGINE-side `lockdown()`; Ironhorse has
//! none, so every SES-mode case is a whole-case named pre-skip
//! (`xst.rs`, `SesMode::unimplemented_skip`). The other two hosts instead
//! evaluate a generated SES prelude, and `packages/test262-runner/src`
//! now carries a third: `ironhorse-prelude.js`.
//!
//! This measures that route. It is not the axis itself — wiring the prelude
//! into `endot-ih` is the follow-up — but it pins how much the shim reaches
//! so the number can only move deliberately.
use ironhorse_vm::{parse_symbols, Interp};

struct TestCompiler;
impl ironhorse_vm::SourceCompiler for TestCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        match ironhorse_compile::compile_atoms_budgeted_with_limit(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        ) {
            Ok(compiled) => Ok(ironhorse_vm::CompiledSource {
                bytecode: compiled.bytecode,
                symbols: compiled.symbols,
                parse_meter_raw: compiled.parse_meter_raw,
                parse_computrons: compiled.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => {
                Err(ironhorse_vm::SourceCompileError::MeterAbort)
            }
            Err(ironhorse_compile::CompileError::Parse(error)) => match error.kind {
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::MeterAbort),
                ironhorse_compile::ParseErrorKind::Unsupported => Err(
                    ironhorse_vm::SourceCompileError::Unsupported(error.to_string()),
                ),
                _ => Err(ironhorse_vm::SourceCompileError::Syntax(error.message)),
            },
        }
    }
}

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");

fn read(rel: &str) -> String {
    std::fs::read_to_string(format!("{ROOT}/{rel}")).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// The host ordering `package.json`'s `test262:xs:text-codec-arraybuffer`
/// documents: harness includes, then the prelude (which captures test262's
/// `assert` on the way past), then the case.
fn program_for(case: &Path) -> String {
    let includes = [
        "sta.js",
        "assert.js",
        "compareArray.js",
        "propertyHelper.js",
        // `ses-hosts.js` names this in its `includes:` front-matter. This
        // harness takes a fixed list rather than reading front-matter, so
        // leaving it out made that case fail here for a missing helper while
        // it passed under the real `test262-harness` — the reach number has
        // to mean the same thing in both places.
        "immutableArrayBufferViewMatrix.js",
    ]
    .iter()
    .map(|f| read(&format!("packages/test262-runner/test262/harness/{f}")))
    .collect::<Vec<_>>()
    .join("\n");
    let prelude = read("packages/test262-runner/prelude/ironhorse.js");
    let body = std::fs::read_to_string(case).expect("case");
    let body = match body.find("---*/") {
        Some(end) => &body[end + 5..],
        None => &body[..],
    };
    format!(
        "{includes}\n{prelude}\nvar __e; try {{ {body} }} catch(e) {{ __e = e; }} \
         __e ? ('FAIL: ' + __e.message) : 'PASS'"
    )
}

fn outcome(case: &Path) -> String {
    let program = program_for(case);
    let mut m = Interp::new();
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let Ok((code, symbols)) =
        ironhorse_compile::compile_atoms_goal(&program, ironhorse_compile::Goal::Script, false)
    else {
        return "COMPILE".into();
    };
    m.link_intrinsics(&parse_symbols(&symbols));
    let o = m.run(&code);
    if !o.completed {
        return format!("HALT {:?}", o.halt);
    }
    if o.result == "PASS" {
        "PASS".into()
    } else {
        "FAIL".into()
    }
}

use std::path::Path;

/// Pinned reach, by file name. `true` is "the case passes on Ironhorse
/// through the shim prelude".
///
/// `Symbol.toStringTag-lockdown.js` is false on Ironhorse AND on node: the
/// node host reports 14/16 today, with both failures on that file
/// (`@endo/harden` installs `Object[Symbol.for('harden')]` before the case
/// calls `lockdown()`, which `repairIntrinsics` refuses). It is not an
/// Ironhorse gap.
const REACH: &[(&str, bool)] = &[
    ("byte-readers.js", true),
    ("native-or-emulated-shape.js", true),
    ("Symbol.toStringTag.js", true),
    ("Symbol.toStringTag-lockdown.js", false),
    // Passes since the `END` frame-base restore (xsRun.c:1063's
    // `mxStack = mxFrameEnd`): `passStyleOf` reaches this case's
    // `assert.sameValue(passStyleOf(bytes), 'byteArray')` through a `return`
    // out of a `switch (typeof ...)`, and the discriminant that `return`
    // abandoned used to land on the caller's pending operand.
    ("byte-array-brand.js", true),
    // Passes on its `ironhorse-ses` row plus `%TypedArray%.prototype.at`, the
    // only read an EMULATED immutable view answers.
    ("ses-hosts.js", true),
    // The `TextEncoder`/`TextDecoder` pair, which share this basename. Ironhorse
    // has no host text codecs; the prelude prepends `polyfills.js`'s codec
    // section, which now implements `encodeInto` and refuses an emulated
    // ArrayBuffer view it cannot read or write, as both cases require.
    ("immutable-arraybuffer-intersection.js", true),
];

#[test]
fn the_ses_shim_prelude_reaches_a_pinned_slice_of_the_parity_corpus() {
    let prelude = format!("{ROOT}/packages/test262-runner/prelude/ironhorse.js");
    if !Path::new(&prelude).exists() {
        assert!(
            std::env::var_os("IRONHORSE_SES_PRELUDE_REQUIRED").is_none(),
            "IRONHORSE_SES_PRELUDE_REQUIRED is set but {prelude} is absent: the \
             lane claims to have run `yarn workspace @endo/test262-runner build` \
             and did not"
        );
        eprintln!("ses-prelude: absent — `yarn workspace @endo/test262-runner build` to run this");
        return;
    }
    let out = std::process::Command::new("grep")
        .args([
            "-rl",
            "ses-xs-parity",
            &format!("{ROOT}/packages/test262-runner/test262/test"),
        ])
        .output()
        .expect("grep");
    let files: Vec<String> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(files.len(), 8, "the ses-xs-parity corpus moved: {files:?}");

    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let mut passed = 0;
            for f in &files {
                let path = Path::new(f);
                let name = path.file_name().unwrap().to_str().unwrap();
                let expected = REACH
                    .iter()
                    .find(|(n, _)| *n == name)
                    .unwrap_or_else(|| panic!("unpinned case {name}"))
                    .1;
                let got = outcome(path);
                eprintln!("  {name:<46} {got}");
                assert_eq!(
                    got == "PASS",
                    expected,
                    "{name}: reach moved (got {got}). Update REACH here, and the \
                     § What decides the profile section of \
                     designs/ironhorse-ses-compartment-equivalence.md."
                );
                passed += usize::from(got == "PASS");
            }
            eprintln!(
                "ses-shim-prelude: {passed}/{} of the parity corpus",
                files.len()
            );
        })
        .unwrap()
        .join()
        .unwrap();
}
