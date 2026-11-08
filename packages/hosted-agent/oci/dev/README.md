# Shared development image

Fae sessions with an isolated shell use this development image. The shell runner
owns its network policy and workspace mount. The image uses Node 22.23.2 and the
2026-09-20 Debian snapshot.
It provides bash, CA certificates, curl, git, ripgrep, C/C++ build tools, Python,
pip, venv, OpenSSL, tar, procps, Chromium, and fonts; it does not add Rust or Go.
The image build runs an offline Chromium smoke test for text layout, software
WebGL, and screenshot output, so missing browser libraries fail the build.
Use `/usr/bin/chromium` as Playwright's `executablePath` to avoid downloading
another browser; install test libraries in native HOME.
Run `node /opt/endo-browser-smoke.mjs` inside the development slice to check it.
For browser tests, keep the test server and browser in the same shell invocation
and clean up the server on exit.
The shell does not provide persistent public hosting or a daemon transport.

Build for the target Linux architecture and pin the printed image ID in the
environment runner configuration:

```sh
sh packages/hosted-agent/oci/dev/build.sh linux/amd64
```

Dependency downloads in the running shell require the session's public-internet
policy.

## Running repository tests in a development slice

Clone the repository into native HOME, for example `/home/node/ebfb`.
Put package caches, installed toolchains and build output there too; the 9P
workspace is for Endo files, not a package manager's native dependency tree.
Use `corepack yarn` directly when the read-only image prevents global shim setup.
For optional user shims, create `/home/node/bin` first, then run
`corepack enable --install-directory /home/node/bin` and add the directory to `PATH`.
Keep the repository's immutable lockfile and lifecycle-script policy.
The managed public-internet environment supplies both ordinary and Yarn-specific
proxy settings; internet-off supplies neither and still denies public networking.

After `corepack yarn install --immutable`, build the declarations before tests
that verify generated tool declarations.
Turbo's ordinary `build` tasks do not provide those declaration prerequisites:

```sh
corepack yarn build:types
CI=1 corepack yarn turbo run test --concurrency=2 --continue=always \
  --filter='!@endo/skel' --env-mode=loose --summarize
```

The `@endo/skel` exclusion matches the repository's root test command; it is a
package template, not an omitted application suite.
`CI=1` uses AVA's CI concurrency and the Turbo limit bounds parallel workspaces.
Loose environment mode retains the supplied proxy settings in child tasks.
Run in the foreground and save complete output in HOME.
If the shell deadline requires batching, split workspace filters without changing
test timeouts or dropping build prerequisites.
The daemon suite is serial and may need several explicit test-file batches;
use paths such as `test/account-bindings-durability.test.js` relative to its
workspace, not bare filenames.
An individually slow file can use exhaustive, non-overlapping AVA title batches.
Verify the installed matcher's behavior and the actual selected arguments;
a no-matching-tests error provides no coverage.
This command exercises JavaScript workspace `test` scripts, not every separate
Rust, XS, test262, lint or typecheck CI lane.
The packaged Chromium and fonts cover ordinary headless browser checks.
Other projects may still need optional system dependencies.
Do not disable signature checks or install packages on the host to repair a slice.
The locked Electron package's explicit `install.js` also worked with
`ELECTRON_GET_USE_PROXY=1`; it retained checksum verification without globally
enabling dependency scripts or fetching an unpinned installer.


### Browser launch recipe

Inside the confined development container, run `node /opt/endo-browser-smoke.mjs`
for the offline browser self-check.
Use this Playwright launch configuration (keep its npm installation in HOME):

```js
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
```

The CLI uses the same arguments plus `--headless`.
These flags rely on the outer container confinement; they are not a host browser recipe.
Close the browser and stop any local server in the same bounded shell invocation.
A software WebGL check does not establish that a physical headset supports WebXR.
