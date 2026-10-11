# @endo/familiar

TODO what is this

## Development

### Quick Start

```bash
cd packages/familiar
yarn build
yarn dev
```

### Electron Install Problems

If you get:
```
/home/user/endo/node_modules/electron/index.js:17
    throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again');
    ^
```

```bash
cd packages/familiar
yarn allow-scripts run
```

### Unix Socket Leftovers

If you ungloriously stop the electron app, say with `SIGINT`, you may see this at next start:
```
[🐈‍⬛ Familiar] Starting...
[🐈‍⬛ Familiar] Dev mode: true
[Familiar] Starting Endo daemon...
[🐈‍⬛ Familiar] Fatal error: Error: listen EADDRINUSE: address already in use /run/user/1000/endo/captp0.sock
    at ChildProcess.<anonymous> (file:///home/jcorbin/endo/packages/familiar/src/daemon-manager.js:188:18)
    at ChildProcess.emit (node:events:518:28)
    at emit (node:internal/child_process:950:14)
    at process.processTicksAndRejections (node:internal/process/task_queues:83:21)
```

A swift `rm /run/user/1000/endo/captp0.sock` shall get you back in business.

**NOTE**: your value of `XDG_RUNTIME_DIR=/run/user/1000` may be different

### Application icons

The Electron packager consumes platform-specific icon files under `assets/`
(`.icns` for macOS, `.ico` for Windows, `icon-<size>.png` for Linux and the
macOS `iconset` indices).
All of those are projected from a single SVG source at `art/familiar.svg`
by `scripts/generate-icons.sh`.

The projection is deterministic on Linux and macOS via the same toolchain:

```sh
# Linux
sudo apt-get install librsvg2-bin icnsutils icoutils
# macOS
brew install librsvg libicns icoutils
```

To regenerate after editing `art/familiar.svg`:

```sh
cd packages/familiar
./scripts/generate-icons.sh        # regenerate everything in place
./scripts/generate-icons.sh --check # CI: verify checked-in assets match source
```

The checked-in artifacts under `assets/` are the canonical inputs to
`@electron/packager`; the regen script is the path for refreshing them.
The `Familiar Icons` GitHub Actions workflow runs `--check` on every PR that
touches the SVG source, the checked-in assets, the regen script, or the
workflow itself.
