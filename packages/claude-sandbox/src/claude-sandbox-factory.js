// @ts-check
/* eslint-disable no-await-in-loop */
/* global process */

/**
 * ClaudeSandbox factory caplet.
 *
 * Presents a "Create Claude Sandbox" form on `@host`'s inbox. Each
 * submission validates the inputs (the `Filesystem` pet name exists,
 * the network profile and rootfs parse), then formulates the session
 * as a first-class `claude-client` caplet via `makeUnconfined`,
 * parameterised by `env`, and stores it under the chosen pet name.
 *
 * The heavy lifting — mounting the `Filesystem` over 9P, registering
 * the mountpoint as a daemon `Mount` cap (`provideMount`), minting the
 * `@endo/sandbox` podman slice, and materialising the credential —
 * lives in [`claude-client-module.js`](./claude-client-module.js),
 * which the client formula runs lazily on first use. The factory does
 * *not* hold those live handles, because an `@endo/sandbox` slice and a
 * 9P mount handle are worker-local remotables with no formula identity:
 * a separately-formulated client cannot receive them across a formula
 * boundary, so the client re-creates them itself from its `env`. This
 * is what gives the stored `ClaudeClient` a real daemon identity (so
 * `storeValue` works) and lets it reincarnate across daemon restarts.
 *
 * This is "plan B" workspace projection: the 9P mount happens on the
 * host (which needs `CAP_SYS_ADMIN` or passwordless `sudo` for
 * `mount`/`umount`, configured on the `fs-mounter` caplet), and the
 * container merely bind-mounts the resulting host mountpoint. Rootless
 * podman cannot itself run `mount -t 9p`, which is why the mount is
 * not performed inside the container.
 *
 * The factory is unconfined and trusted: it holds full host authority
 * via `host-agent` (the `@agent` cap). The credential secret never
 * passes through the factory — only the credential's pet name does, in
 * the client formula's `env`. Treat its source as part of the trusted
 * compute base.
 *
 * @module
 */

import os from 'node:os';
import nodePath from 'node:path';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { parseRootfs, rootfsLabel } from './parse-rootfs.js';

const clientModuleSpecifier = new URL(
  './claude-client-module.js',
  import.meta.url,
).href;

/**
 * Source for a **per-session powers** cap, built by the factory via
 * `E(hostAgent).evaluate(...)`. It is a total attenuation of the host: it
 * closes over the four caps the client needs (resolved once, by reference,
 * from the endowed pet names) and `@agent`, and exposes **only** four
 * accessors plus a `provideMount` bounded to *this session's* workspace
 * mountpoint. There is no `lookup`, so the client cannot reach any host
 * name beyond its own caps.
 *
 * Endowed in the eval compartment (see `packages/daemon/src/worker.js`):
 * `makeExo`, `M`, `E`, plus `agent` / `sandboxFactory` / `fsMounter` /
 * `filesystem` / `credentials` (the last omitted when the session has no
 * credential — the accessor is then a baked `null`).
 *
 * @param {string} mountPoint - the session's host 9P mountpoint; the only
 *   path `provideMount` will accept.
 * @param {boolean} hasCredentials
 * @returns {string}
 */
const buildSessionPowersSource = (mountPoint, hasCredentials) => `makeExo(
  'ClaudeSessionPowers',
  M.interface('ClaudeSessionPowers', {
    sandboxFactory: M.call().returns(M.any()),
    fsMounter: M.call().returns(M.any()),
    filesystem: M.call().returns(M.any()),
    credentials: M.call().returns(M.any()),
    provideMount: M.call(M.string(), M.string()).returns(M.promise()),
    help: M.call().returns(M.string()),
  }),
  {
    sandboxFactory: () => sandboxFactory,
    fsMounter: () => fsMounter,
    filesystem: () => filesystem,
    credentials: () => ${hasCredentials ? 'credentials' : 'null'},
    provideMount: (path, name) => {
      if (path !== ${JSON.stringify(mountPoint)}) {
        throw Error('claude-sandbox session powers: provideMount restricted to this session workspace mountpoint');
      }
      return E(agent).provideMount(path, name);
    },
    help: () =>
      'Per-session claude-sandbox powers: sandboxFactory/fsMounter/filesystem/credentials accessors + provideMount bounded to this session mountpoint. No lookup.',
  },
)`;

/**
 * Subset of the inbox message shape this caplet reads. The `@host`
 * inbox API is dynamically typed at the Endo boundary; we narrow at
 * the read site.
 *
 * @typedef {object} InboxMessage
 * @property {string} from
 * @property {'form' | 'value' | string} type
 * @property {string} [messageId]
 * @property {string} [replyTo]
 * @property {number} number
 * @property {string} [valueId]
 */

/**
 * Subset of the "Create Claude Sandbox" form submission.
 *
 * @typedef {object} SandboxFormSubmission
 * @property {string} name
 * @property {string} filesystem
 * @property {string} [rootfs]
 * @property {string} [network]
 * @property {string} [model]
 * @property {string} [credentials]
 * @property {string} [initialPrompt]
 */

/**
 * Constructor wrapper / test-injection bag passed as the third arg.
 *
 * @typedef {object} ContextOrDeps
 * @property {Record<string, string>} [env]
 * @property {(readerRef: any) => AsyncIterator<any>} [iterateMessages] -
 *   Adapt the `@host` message reader into an async iterator (tests);
 *   defaults to `@endo/exo-stream`'s `iterateReader`.
 */

const FactoryInterface = M.interface('ClaudeSandboxFactory', {
  createSession: M.call(M.record()).returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});

const FORM_DESCRIPTION = 'Create Claude Sandbox';

const FORM_FIELDS = harden([
  {
    name: 'name',
    label: 'Pet name for the new ClaudeClient',
    default: 'claude-1',
  },
  {
    name: 'filesystem',
    label: 'Pet name of a Filesystem capability in @host petstore',
    example: 'Examples: my-workspace, project-fs',
  },
  {
    name: 'rootfs',
    label:
      'Container rootfs — an OCI image with BOTH node and the claude CLI (or host-bind/minimal). Leaving this blank uses the built-in default node image, which does NOT include claude: the session then fails with "claude: not found". Set CLAUDE_SANDBOX_IMAGE on the daemon or supply an image here.',
    default: '',
    example: 'Examples: oci:docker.io/myorg/claude:latest, host-bind',
  },
  {
    name: 'network',
    label: 'Sandbox network profile',
    default: 'private',
    example: 'none | private | host-loopback | host-lan | host-net',
  },
  {
    name: 'model',
    label: 'Claude model id (optional)',
    default: '',
    example: 'Examples: claude-sonnet-4-6, claude-opus-4-7',
  },
  {
    name: 'credentials',
    label: 'Pet name of a ClaudeCredentials cap (optional)',
    default: '',
    example: 'Examples: claude-credentials',
  },
  {
    name: 'initialPrompt',
    label: 'Initial prompt (optional)',
    default: '',
  },
]);

const SANDBOX_WORKSPACE_PATH = '/workspace';

const ALLOWED_NETWORKS = harden([
  'none',
  'private',
  'host-loopback',
  'host-lan',
  'host-net',
]);

/**
 * Slugify a pet name into a filesystem- and pet-name-safe token used
 * for the per-session mountpoint and workspace pet name. Pet names are
 * already lowercase/alnum/hyphen; this is belt-and-suspenders so an
 * unexpected input cannot escape the mount base dir.
 *
 * @param {string} name
 */
const slugify = name =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'claude';

/**
 * Factory caplet entry point.
 *
 * The third argument is overloaded: Endo's `makeUnconfined` worker
 * path passes the frozen `{ env }` wrapper; tests pass an
 * `iterateMessages` adapter to drive the inbox loop synchronously.
 *
 * @param {import('@endo/eventual-send').FarRef<object>} guestPowers
 * @param {Promise<object> | object | undefined} _context
 * @param {ContextOrDeps} [contextOrDeps]
 * @returns {object}
 */
export const make = (guestPowers, _context, contextOrDeps = {}) => {
  /** @type {any} */
  const powers = guestPowers;
  const deps = contextOrDeps;
  const env = deps.env ?? {};

  const sandboxFactoryName =
    env.SANDBOX_FACTORY_NAME ||
    process.env.SANDBOX_FACTORY_NAME ||
    'sandbox-factory';
  const fsMounterName =
    env.FS_MOUNTER_NAME || process.env.FS_MOUNTER_NAME || 'fs-mounter';
  // Directory the host-side infra caplets (`sandbox-factory`, `fs-mounter`)
  // live under, so the per-session powers can endow them by path. Empty
  // means they sit at the host root (the bare names). Set by the
  // provisioner (factory.js) to the factory's own directory.
  const sandboxNamespace =
    env.SANDBOX_NAMESPACE || process.env.SANDBOX_NAMESPACE || '';
  /** @param {string} name @returns {string | string[]} */
  const underNamespace = name =>
    sandboxNamespace ? [sandboxNamespace, name] : name;
  const backend =
    env.CLAUDE_SANDBOX_BACKEND ||
    process.env.CLAUDE_SANDBOX_BACKEND ||
    'podman';
  const defaultImage =
    env.CLAUDE_SANDBOX_IMAGE || process.env.CLAUDE_SANDBOX_IMAGE || undefined;
  const mountBaseDir =
    env.CLAUDE_SANDBOX_MOUNT_DIR ||
    process.env.CLAUDE_SANDBOX_MOUNT_DIR ||
    os.tmpdir();
  const iterateMessages = deps.iterateMessages ?? iterateReader;

  // Monotonic per-worker counter so two sessions formulated in the same
  // millisecond get distinct ids (and hence distinct mountpoints + workspace
  // pet names). `Date.now()` alone collides for same-name same-ms requests.
  let sessionCounter = 0;

  /** @type {Promise<any> | undefined} */
  let hostAgentP;
  const getHostAgent = () => {
    if (hostAgentP === undefined) {
      hostAgentP = E(powers).lookup('host-agent');
    }
    return hostAgentP;
  };

  /**
   * Validate a session config and formulate the `claude-client`
   * caplet.
   *
   * With `resultName`, the client is stored under that pet name in
   * `@host`'s petstore — a host-side GC root (the operator/form path).
   * Without it, the client is formulated **un-named** and returned, so
   * the *caller's* retention is its only GC root: dropping the returned
   * cap collects the session, and its `whenCancelled` teardown disposes
   * the container and unmounts the workspace. See DESIGN.md § Lifecycle.
   *
   * The credential is passed by pet name and re-materialised inside the
   * client at spawn time, so no secret ever enters the formula `env`.
   *
   * @param {SandboxFormSubmission} config
   * @param {{ resultName?: string }} [opts]
   * @returns {Promise<{ client: any, sessionId: string, hostMountPoint: string, rootfsLabel: string }>}
   */
  const formulateSession = async (config, { resultName } = {}) => {
    const {
      name,
      filesystem: fsName,
      rootfs: rootfsValue = '',
      network = 'private',
      model = '',
      credentials: credsName = '',
      initialPrompt = '',
    } = config;

    if (!name) throw new Error('Missing "name".');
    if (!fsName) throw new Error('Missing "filesystem" pet name.');
    if (!ALLOWED_NETWORKS.includes(network)) {
      throw new Error(
        `Unknown network profile "${network}"; expected one of ${ALLOWED_NETWORKS.join(', ')}.`,
      );
    }

    const hostAgent = await getHostAgent();
    // Validate the filesystem exists and the rootfs parses now, for a
    // friendly error; the client formula re-resolves both from its env.
    const fs = await E(hostAgent).lookup(fsName);
    if (!fs) throw new Error(`Unknown filesystem: "${fsName}".`);
    const parsedRootfs = parseRootfs(rootfsValue, { defaultImage });

    const slug = slugify(name);
    sessionCounter += 1;
    const sessionId = `${slug}-${Date.now().toString(36)}-${sessionCounter.toString(36)}`;
    const hostMountPoint = nodePath.join(
      mountBaseDir,
      `claude-sandbox-${sessionId}`,
    );
    const workspacePetName = `claude-${sessionId}-workspace`;

    // Least authority: the client runs as a **per-session powers** cap that
    // bundles its four caps by reference and a `provideMount` bounded to
    // this session's mountpoint — no `lookup`, no other host reach. The
    // caps are endowed by pet name (resolved once, here); the credential is
    // optional. `makeUnconfined` is Host-only and resolves `powersName`
    // against the host petstore, so the cap must be host-named — but we
    // remove the name immediately after `makeUnconfined` below.
    const powersName = `claude-${sessionId}-powers`;
    const codeNames = ['agent', 'sandboxFactory', 'fsMounter', 'filesystem'];
    // The infra caps resolve under the factory's directory (if any); the
    // filesystem and credential are the peer's/operator's own top-level caps.
    const petNames = [
      '@agent',
      underNamespace(sandboxFactoryName),
      underNamespace(fsMounterName),
      fsName,
    ];
    if (credsName) {
      codeNames.push('credentials');
      petNames.push(credsName);
    }
    await E(hostAgent).evaluate(
      '@main',
      buildSessionPowersSource(hostMountPoint, Boolean(credsName)),
      harden(codeNames),
      harden(petNames),
      powersName,
    );

    /** @type {Record<string, any>} */
    const options = {
      powersName,
      env: harden({
        SESSION_ID: sessionId,
        CREATED_AT: new Date().toISOString(),
        WORKSPACE_MOUNT_POINT: hostMountPoint,
        WORKSPACE_PET_NAME: workspacePetName,
        WORKSPACE_PATH: SANDBOX_WORKSPACE_PATH,
        BACKEND: backend,
        NETWORK: network,
        CLAUDE_ROOTFS: rootfsValue,
        DEFAULT_IMAGE: defaultImage ?? '',
        MODEL: model,
        INITIAL_PROMPT: initialPrompt,
      }),
    };
    if (resultName !== undefined) {
      options.resultName = resultName;
    }
    const client = await E(hostAgent).makeUnconfined(
      '@main',
      clientModuleSpecifier,
      harden(options),
    );

    // Unname the per-session powers. The make-unconfined formula's `powers`
    // dependency edge (daemon graph) keeps it reachable for exactly the
    // client's lifetime, so dropping its pet name leaves no host-petstore
    // residue and lets it be collected *with* the client — keeping the
    // peer-rooted `createSession` GC clean (no per-session leak).
    await E(hostAgent).remove(powersName);

    return harden({
      client,
      sessionId,
      hostMountPoint,
      rootfsLabel: rootfsLabel(parsedRootfs),
    });
  };

  const seenFormReplies = new Set();

  const runFactory = async () => {
    await E(powers).form('@host', FORM_DESCRIPTION, FORM_FIELDS);

    const selfId = await E(powers).locate('@self');

    /** @type {string | undefined} */
    let formMessageId;
    const existingMessages = /** @type {InboxMessage[]} */ (
      await E(powers).listMessages()
    );
    for (const msg of existingMessages) {
      if (msg.from === selfId && msg.type === 'form') {
        formMessageId = msg.messageId;
      }
    }

    const messageIterator = iterateMessages(E(powers).followMessages());
    let exhausted = false;
    while (!exhausted) {
      const { value: message, done } = await messageIterator.next();
      if (done) {
        exhausted = true;
        break;
      }

      const msg = /** @type {InboxMessage} */ (message);
      const isOurForm = msg.from === selfId && msg.type === 'form';
      const isFormReply =
        msg.type === 'value' &&
        formMessageId !== undefined &&
        msg.replyTo === formMessageId &&
        !seenFormReplies.has(msg.number);

      if (isOurForm) {
        formMessageId = msg.messageId;
      } else if (isFormReply) {
        seenFormReplies.add(msg.number);
        try {
          const submission = /** @type {SandboxFormSubmission} */ (
            await E(powers).lookupById(msg.valueId)
          );
          // Operator/form path: store under the chosen pet name (a
          // host-side root) so it lands in @host's petstore.
          const {
            sessionId,
            hostMountPoint,
            rootfsLabel: rfLabel,
          } = await formulateSession(submission, {
            resultName: submission.name,
          });

          await E(powers).reply(
            msg.number,
            [
              `ClaudeClient "${submission.name}" created.`,
              `  session:    ${sessionId}`,
              `  filesystem: ${submission.filesystem}`,
              `  workspace:  ${hostMountPoint} -> ${SANDBOX_WORKSPACE_PATH}`,
              `  rootfs:     ${rfLabel}`,
              `  backend:    ${backend}`,
              `  network:    ${submission.network ?? 'private'}`,
            ],
            [],
            [],
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          // eslint-disable-next-line no-console
          console.error('[claude-sandbox-factory]', errorMessage);
          try {
            await E(powers).reply(
              msg.number,
              [`Error creating sandbox: ${errorMessage}`],
              [],
              [],
            );
          } catch {
            // best-effort reply
          }
        }
      }
    }
  };

  runFactory().catch(error => {
    // eslint-disable-next-line no-console
    console.error('[claude-sandbox-factory] Factory error:', error);
  });

  return makeExo('ClaudeSandboxFactory', FactoryInterface, {
    /**
     * Peer-callable: formulate a Claude session and **return** its
     * `ClaudeClient` cap. The session is *not* stored under a host pet
     * name, so the calling peer's retention is its only GC root —
     * dropping the returned cap collects the session, and the client's
     * `whenCancelled` teardown disposes the container and unmounts the
     * workspace. See DESIGN.md § Lifecycle.
     *
     * `config` mirrors the form fields: `{ name, filesystem, rootfs?,
     * network?, model?, credentials?, initialPrompt? }`, where
     * `filesystem` and `credentials` are pet names resolvable in
     * `@host`'s namespace.
     *
     * @param {Record<string, any>} config
     * @returns {Promise<any>}
     */
    async createSession(config) {
      const { client } = await formulateSession(
        /** @type {SandboxFormSubmission} */ (config),
      );
      return client;
    },

    /**
     * @param {string} [methodName]
     * @returns {string}
     */
    help(methodName) {
      if (methodName === undefined) {
        return [
          'ClaudeSandboxFactory.',
          '',
          'createSession(config) → ClaudeClient cap (peer-callable; the',
          '  caller holds the only reference, so dropping it destroys the',
          '  session). config mirrors the form fields below.',
          '',
          'Or submit the "Create Claude Sandbox" form on @host with:',
          '  name        — pet name for the resulting ClaudeClient',
          '  filesystem  — pet name of an existing Filesystem capability',
          '  rootfs      — OCI image (oci:<ref> or bare ref) or host-bind/minimal',
          '  network     — none | private | host-loopback | host-lan | host-net',
          '  model       — optional claude model id',
          '  credentials — optional ClaudeCredentials pet name',
          '  initialPrompt — optional first message',
          '',
          'The workspace Filesystem is mounted on the host over 9P and',
          'bind-mounted into the podman slice at /workspace.',
        ].join('\n');
      }
      return `No documentation for method "${methodName}".`;
    },
  });
};
harden(make);
