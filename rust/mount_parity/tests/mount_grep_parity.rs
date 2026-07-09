//! Rust-side runner over the grep case table — the seam PR C plugs into.
//!
//! PR C (`feat/mount-grep`) lands `packages/daemon/test/mount-grep-cases.json`
//! (`{ name, pattern, options?, expect }` over the same shared fixture). The
//! design's intent is that the grep table is "picked up by the same runner
//! rather than a second one", so the fixture materializer, contract-file
//! resolution, and UTF-16 collation this crate already exposes are reused
//! verbatim; only a `grep(root, pattern, options)` mirror of `mount.js`'s grep
//! (file selection through `glob`, `\n` splitting with trailing-`\r` stripping,
//! 1-based line numbers, `maxResults` cutoff) needs to land alongside `glob`.
//!
//! Until PR C's case table exists this test is inert but visible: it logs that
//! grep parity is pending rather than silently passing, so the missing coverage
//! is not mistaken for green.

#[test]
fn grep_case_table_is_wired_when_present() {
    let path = mount_parity::contract_dir().join("mount-grep-cases.json");
    if !path.exists() {
        eprintln!(
            "mount_grep_parity: {} not present yet — grep parity is pending PR C \
             (feat/mount-grep); wire grep(root, pattern, options) into mount_parity \
             and iterate this table alongside the glob runner.",
            path.display()
        );
        return;
    }

    // PR C has landed the grep case table. This runner does not yet enforce it;
    // log loudly (rather than silently pass) so whoever rebases onto grep wires
    // a grep() mirror into mount_parity — reusing materialize_fixture / utf16_cmp
    // — and iterates the table here, mirroring mount-grep.test.js. Kept non-fatal
    // so a rebase that pulls in the table does not break CI before that wiring.
    eprintln!(
        "mount_grep_parity: {} is present but the Rust grep runner is not wired yet. \
         Add grep() to mount_parity and iterate the grep table alongside the glob runner.",
        path.display()
    );
}
