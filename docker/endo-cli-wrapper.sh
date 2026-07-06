#!/bin/sh
# `endo` convenience wrapper so `docker exec <container> endo <verb>` reaches the
# bundled CLI. The CLI resolves the daemon socket and state directory from the
# XDG environment baked into the image, so it connects to the running daemon
# rather than trying to spawn its own.
exec node /opt/endo/bundles/endo-cli.mjs "$@"
