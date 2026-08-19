---
'@endo/9p-server': minor
'@endo/claude-sandbox': patch
---

Add `@endo/9p-server/mount-projection.js`, the shared layer that turns a
capability describing a filesystem into a host path a bind-mount can consume:
the capability's own directory when a caller-supplied resolver names one, and
the 9P bridge → kernel mount chain when it does not. Each projection carries an
idempotent, best-effort `release()`.

`mount-caplet.js` additionally exports `makeNodeFsMounter`, the Node-effect
wiring its `make-unconfined` entry point already used, so an in-process holder
of Node authority (the daemon's `sandbox` formula, through the host-tool seam)
can build a mounter without going through a formula. Both `mount-caplet.js` and
`mount-projection.js` are now named in the package's `exports`.

`@endo/claude-sandbox` consumes the shared layer for its per-session workspace
instead of carrying its own copy of the chain; observable behavior is unchanged.
