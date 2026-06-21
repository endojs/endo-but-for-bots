// @ts-check
/* global process */
// endo run --UNCONFINED setup.js --powers @agent
//   [-E NINEP_SUDO=1]
//   [-E CLAUDE_SANDBOX_IMAGE=oci.example/claude:latest]
//   [-E CLAUDE_SANDBOX_MOUNT_DIR=/var/lib/endo/claude-mounts]
//
// One-shot provisioning for the Claude sandbox stack. Idempotently
// mints, under @host:
//
//   1. `sandbox-factory`  — the `@endo/sandbox` plugin (podman/bwrap).
//   2. `fs-mounter`       — the `@endo/9p-server` mount caplet, which
//                           mounts a Filesystem cap into the host
//                           kernel over 9P. `mount(2)` needs
//                           `CAP_SYS_ADMIN`; pass `-E NINEP_SUDO=1` to
//                           route mount/umount through `sudo` on an
//                           unprivileged daemon (see 9p-server DEMO.md
//                           B4).
//   3. `claude-credentials-factory` — form-mintable Anthropic API key
//                           wrapper.
//   4. `claude-sandbox-factory`     — the "Create Claude Sandbox" form.
//      Each session's client runs as a per-session attenuated powers cap
//      the factory builds (caps-by-reference + a mountpoint-bounded
//      provideMount, no lookup), not `@agent`.
//
// After running, submit the two forms (`endo inbox`, `endo submit`).

import { E } from '@endo/eventual-send';

import { main as provisionCredentialsFactory } from './credentials.js';
import { main as provisionSandboxFactory } from './factory.js';

/** @import { EndoHost } from '@endo/daemon' */

const sandboxSpecifier = new URL('../sandbox/src/agent.js', import.meta.url)
  .href;
const mountCapletSpecifier = new URL(
  '../9p-server/mount-caplet.js',
  import.meta.url,
).href;

/**
 * @param {EndoHost} hostAgent
 */
export const main = async hostAgent => {
  const { env } = process;

  // 1. Sandbox factory — `@agent` powers grant the privileged
  //    `provideHostPath` / `provideScratchMount` surface the factory
  //    needs to bridge granted Mount caps into the kernel's bind-mount
  //    surface.
  if (!(await E(hostAgent).has('sandbox-factory'))) {
    await E(hostAgent).makeUnconfined('@main', sandboxSpecifier, {
      powersName: '@agent',
      resultName: 'sandbox-factory',
    });
    console.log('Minted sandbox-factory');
  }

  // 2. 9P mounter — unconfined; uses ambient Node authority (no Endo
  //    powers). Thread the NINEP_* knobs so an unprivileged daemon can
  //    route mount/umount through sudo and so the socket dir is
  //    configurable.
  if (!(await E(hostAgent).has('fs-mounter'))) {
    /** @type {Record<string, string>} */
    const mounterEnv = {};
    for (const key of ['NINEP_SUDO', 'NINEP_LAZY_UMOUNT', 'NINEP_SOCKET_DIR']) {
      if (env[key] !== undefined) {
        mounterEnv[key] = /** @type {string} */ (env[key]);
      }
    }
    await E(hostAgent).makeUnconfined('@main', mountCapletSpecifier, {
      powersName: '@none',
      resultName: 'fs-mounter',
      env: harden(mounterEnv),
    });
    console.log('Minted fs-mounter');
  }

  // 3. Credentials factory.
  await provisionCredentialsFactory(hostAgent);

  // 4. Claude sandbox factory (reads sandbox-factory / fs-mounter from
  //    @host by pet name at form-submission time).
  await provisionSandboxFactory(hostAgent);

  console.log('Claude sandbox setup complete.');
  console.log(
    'Next: `endo inbox`, then submit the "Create Claude Credentials" and "Create Claude Sandbox" forms with `endo submit`.',
  );
};
harden(main);
