# Saboteur adversarial review

When reviewing PRs as the adversarial-perspective reviewer in a parallel
panel, focus on attack classes the regular reviewers cover poorly:
type-correctness reviewers see "the function takes a string and returns
a string"; the saboteur asks "what if the string is `..` / `\n` / `:` /
a symlink / from a different namespace than expected?".

Cite [self-improvement.md](./self-improvement.md) as the meta-pattern
for capturing review classes here.

## Reusable patterns

### Rootfs-derived environment derivation

Whenever a sandbox / container driver derives an environment variable
(`$PATH`, `$LD_LIBRARY_PATH`, `$XDG_*`, `$NODE_PATH`, …) from the host
filesystem layout — by probing for canonical bin dirs, mining the
ambient env, or inspecting an OCI image's `Config.Env` — there is a
class of attacks that string-shape unit tests do not catch:

1. **`realpath` blind spots.** A textual prefix check
   (`startsWith('/tmp/')`) does not see through symlinks.
   Operator-installed `/opt/eve -> /tmp/attacker` survives the filter
   and becomes a writable entry on the slice's derived `$PATH`.
   Mitigation: resolve survivors with `fs.realpathSync` and re-apply
   the prefix check to the resolved value.

2. **Delimiter injection through cap-supplied strings.** Joining
   derived entries with `:` (or `;` / `\0`) without validating the
   entries for the delimiter silently lets a caller inject extra
   `$PATH` entries by embedding a `:` in their `innerPath` /
   `hostPath`.  Newlines corrupt the wire format of the spawn argv
   (`--setenv PATH …`, `-e PATH=…`, env-files).  Add a guard:
   `if (entry.includes(':') || /[\x00-\x1f]/.test(entry)) drop;`.

3. **Relative-path probing.** A non-absolute `hostPath` (`srv/foo`,
   `..`) makes `existsSync(`${hostPath}/usr/bin`)` probe against the
   daemon's CWD.  Even when the downstream bind-mount fails safely,
   the synthesised `$PATH` ends up reflecting daemon-CWD-shaped
   probes that have nothing to do with the slice.  Fail closed
   early: `if (!hostPath.startsWith('/')) return [];`.

4. **Empty-probe fallback to host-shaped defaults.** When the rootfs
   probe finds no canonical bin dirs, falling back to a hard-coded
   `/usr/local/bin:/usr/bin:/bin:…` pointed at non-existent paths is
   user-hostile (commands fail with `ENOENT` for non-obvious
   reasons) and inconsistent with the rationale comment ("so the
   slice can at least find sh/echo if the caller bound a standard
   userland tree" — which is the case the probe just disproved).
   Either fall back to empty (force the caller to set PATH) or
   document the guarantee.

5. **TOCTOU between make-time derivation and spawn.** Confirm whether
   the derived value is snapshotted at `make()` (so rootfs mutations
   between make and spawn are not reflected) or re-derived per spawn.
   Either is defensible; flag undocumented choice.

6. **Caller-PATH precedence.** Whether the derived value lands
   before or after caller-supplied entries determines whether a
   hostile mount can shadow `/usr/bin`.  The defensible choice is
   "rootfs-defaults first, caller-mounts last".  Flag if undocumented
   or inverted.

### Application

Run these six checks on any PR that touches a `drivers/path.js`-shaped
file, or that adds any `process.env`-mining / image-inspection /
mount-probing code path that ends up in a `spawn` argv.  The
unit-test surface for these helpers will not exercise symlink
resolution, control-character injection, or cwd-relative probing
because all three require an existsSync probe with realistic side
effects — they need adversarial test cases, not just shape tests.
