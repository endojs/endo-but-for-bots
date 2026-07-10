# mount_parity

The **Rust-side runner** for the cross-language `EndoMount` glob/grep parity
case tables.

`packages/daemon/test/` carries a declarative, language-neutral data contract
for the mount search surface:

- `mount-fixture-manifest.json` — the canonical fixture tree (files, empty
  directories, denied credential names, a base64 binary probe, an optional
  escaping symlink).
- `mount-glob-cases.json` — the glob variant coverage matrix, each case pinning
  the exact `EndoMount.glob(pattern)` result over that fixture, sorted by UTF-16
  code unit.
- `mount-grep-cases.json` — the grep matrix (landed by PR C), consumed by the
  same runner once present.

The Node runner (`mount-glob.test.js`) iterates the same tables against the real
`mount.js` under V8. This crate is the design's **Rust-side** runner
(`designs/mount-extensions-reconstruction.md` § "Test strategy": *"a Rust-side
or XS-supervisor-side runner consumes the same three JSON files to assert
identical results"*). It materializes the manifest exactly as the Node
materializer does (`_mount-fixture.js`) and reproduces `glob`'s
normatively-specified semantics in Rust, so a mismatch is either a case-table
regression or a drift between the normative glob spec and this mirror.

```sh
cargo test -p mount_parity
```

The crate has no dependency on the `xsnap` / `endo` crates, so it builds and
tests independently of the XS engine bundles.

## Scope and the XS-supervisor variant

The design offers two runner shapes: a **Rust-side** implementation matching the
normative spec (this crate), or an **XS-supervisor-side** runner that drives the
*real* `mount.js` under XS. Only the latter proves "the same `mount.js` runs
under the Rust supervisor"; this Rust-side runner instead confirms the fixture
materializes identically cross-language and that a spec-faithful glob reproduces
the pinned `expect` values (drift in `mount.js` itself is caught by the Node
runner, which asserts the same `expect` against real `mount.js`).

The XS-supervisor variant is a follow-up blocked on the XS worker/SES-boot path
becoming buildable from this tree (see `rust/endo/README.md` §"Not yet
runnable": the worker/SES-boot generators are absent and the daemon bundler
fails on Node-only imports). Once that path builds, the same fixture materializer
and case-table loaders here can back an XS-run assertion.

## Grep (PR C)

`tests/mount_grep_parity.rs` is the seam PR C plugs into. The fixture
materializer, contract-file resolution, and UTF-16 collation are reused verbatim;
only a `grep(root, pattern, options)` mirror of `mount.js`'s grep needs to land
alongside `glob`.
