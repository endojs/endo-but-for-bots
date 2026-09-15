//! The stage-4 SES boot bar, measured against the daemon's own boot sequence.
//!
//! `designs/ironhorse-engine.md` stage 4 asks for "the endor daemon boot
//! bundles … running identically on both engines". `ironhorse-262`'s in-crate
//! `stage4_daemon_boot_bundle_agrees_with_the_pin` covers the two COMMITTED
//! bundles (`polyfills.js`, `host_aliases.js`). This covers the third,
//! `ses_boot.js`, which is generated rather than committed (`.gitignore:35`,
//! produced by `yarn bundle:xs`), so the bar runs where the bundle exists and
//! skips where it does not.
//!
//! It runs the sequence `bootstrap_ses` actually runs — `POLYFILLS`, then
//! `SES_BOOT` through `eval_wrapped`'s try/catch shape, on ONE machine
//! (`rust/endo/xsnap/src/lib.rs:1260`) — rather than a concatenation of the
//! three sources, which is not a program either engine accepts.
use ironhorse_262::dual_run_cranks;

fn bundle(name: &str) -> Option<String> {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../endo/xsnap/src")
            .join(name),
    )
    .ok()
}

/// `eval_wrapped` (`xsnap/src/lib.rs:1077`): the daemon never evaluates the
/// boot bundle bare, so neither does the bar.
fn wrapped(code: &str) -> String {
    format!(
        "var __e = undefined; try {{ {code} }} catch(e) {{ __e = e; }} \
         __e ? ('ERROR: ' + __e.message) : 'ok'"
    )
}

/// One global's `typeof` on each engine, as a census string.
const CENSUS: &str = "['lockdown','harden','Compartment','HandledPromise','assert']\
    .map(function(n){ return n + '=' + (typeof globalThis[n]); }).join(' ')";

#[test]
fn ses_boot_bundle_runs_identically_and_names_what_it_does_not_install() {
    let (Some(polyfills), Some(ses)) = (bundle("polyfills.js"), bundle("ses_boot.js")) else {
        eprintln!(
            "stage4-ses: ses_boot.js absent — generate it with `yarn bundle:xs` to run this bar"
        );
        return;
    };

    let boot = wrapped(&ses);
    let sources = [polyfills.as_str(), CENSUS, boot.as_str(), CENSUS];
    let runs = dual_run_cranks(&sources).expect("the oracle machine starts");
    let (before, evaluated, after) = (&runs[1], &runs[2], &runs[3]);

    // (1) The bundle itself is at the bar: both engines evaluate it to the
    //     same completion, and `eval_wrapped`'s contract is that the value is
    //     `'ok'` exactly when nothing threw.
    assert_eq!(
        evaluated.oracle_result, evaluated.ironhorse_result,
        "the boot bundle must evaluate to the same value on both engines"
    );
    assert_eq!(
        evaluated.ironhorse_result, "ok",
        "the boot bundle must evaluate without throwing on ironhorse"
    );

    // (2) What the bundle actually installs, it installs on BOTH engines.
    //     `ses_boot.js` bundles `@endo/harden`, `@endo/env-options` and
    //     `@endo/eventual-send` — not the SES shim — so `harden` and
    //     `HandledPromise` are its observable effects.
    for global in ["harden", "HandledPromise"] {
        let needle = format!("{global}=function");
        assert!(
            after.ironhorse_result.contains(&needle),
            "the bundle must install {global} on ironhorse: {}",
            after.ironhorse_result
        );
        assert!(
            after.oracle_result.contains(&needle),
            "the bundle must install {global} on the oracle: {}",
            after.oracle_result
        );
    }

    // (3) The gap, pinned so it cannot widen silently and cannot close
    //     silently either. `lockdown` and `Compartment` are present on XS
    //     BEFORE the bundle runs — they are XS's NATIVE SES, which the engine
    //     design records at `designs/ironhorse-engine.md:201` ("XS implements
    //     SES natively") — and the bundle does not carry them: it has three
    //     `globalThis.harden` assignments and no `globalThis.lockdown` or
    //     `globalThis.Compartment` at all.
    //
    //     So stage 4's remaining work is not "make the bundle run". It is that
    //     ironhorse has no `lockdown` and no `Compartment`, natively or from a
    //     bundle. When either lands, this assertion fails and the bar is
    //     rewritten to require it — which is the point of pinning it.
    for native_ses in ["lockdown", "Compartment"] {
        assert!(
            before
                .oracle_result
                .contains(&format!("{native_ses}=function")),
            "XS is expected to provide {native_ses} natively, before the bundle: {}",
            before.oracle_result
        );
        assert!(
            after
                .ironhorse_result
                .contains(&format!("{native_ses}=undefined")),
            "ironhorse is expected to still lack {native_ses} (ledger row \
             `boot:ses-lockdown-bundle`); if it now has one, this bar must be \
             rewritten to require it: {}",
            after.ironhorse_result
        );
    }

    eprintln!(
        "stage4-ses: bundle agrees; before={}",
        before.ironhorse_result
    );
    eprintln!("stage4-ses: after ={}", after.ironhorse_result);
}
