// @ts-check
/**
 * The M3 gateway and UI contract, Node and browser side (milestones.md M3
 * W3.0; `designs/m3-interfaces.md`). Plain data and type definitions only:
 * no prelude, no Node or browser API, so the gateway (Node, in the agent-host
 * adapter), the browser bundle (`ui/build.mjs`) and tests import it alike.
 * What crosses a vat boundary is in `guest/lib/interfaces-m3.js`.
 *
 * Adapter settings (as `config/defaults.js` `channelLimits`): the gateway
 * process holds this state, not a vat, so these are not vat limits.
 */

/** Gateway protocol revision (the shell embeds it; a mismatch reloads). */
export const GATEWAY_PROTOCOL = 1;

/** The only path a CapTP WebSocket upgrade is accepted on (D-12). */
export const WS_PATH = '/ws';

/** Bounds of the gateway (m3-interfaces.md 4). */
export const gatewayLimits = Object.freeze({
  /** One WebSocket message, either direction (architecture 7). */
  wsMessageBytes: 1_048_576,
  /** Open WebSocket connections, all clients. */
  maxConnections: 64,
  /** Open WebSocket connections from one client address. */
  connectionsPerAddress: 16,
  /** A connection that has not signed in within this is closed. */
  signInDeadlineMs: 15_000,
  /**
   * Calls a connection may have waiting for an answer from a vat target
   * (Live and LiveSubscription waits do not count). One more is refused
   * with `gatewayTexts.tooManyCalls`; nothing reaches the target.
   */
  callsInFlight: 32,
  /**
   * Objects the gateway's CapTP side may have exported to one connection.
   * Each keeps an OCapN import (a hub row entry of its vat) alive; over it
   * the connection is closed with `closeCodes.tooManyObjects` and the page
   * rebuilds from scratch.
   */
  exportsPerConnection: 4096,
  /**
   * Answers (the page's question ids, CapTP's answer table and the bridge's
   * mirror of it) the gateway keeps for one connection. A page's captp
   * drops each question it no longer holds (`gcImports`); past the bound
   * the oldest settled answers are forgotten (a `CTP_DROP` is dispatched to
   * the gateway's captp for each), so a long-lived page is never closed for
   * it. Only when every kept answer is still unsettled is the connection
   * closed with `closeCodes.tooManyObjects`.
   */
  answersPerConnection: 4096,
  /** R7-49: each failed sign-in pushes that address's next attempt this far. */
  signInPenaltyMs: 1000,
  /** R7-49: an address's entry is forgotten this long after its deadline. */
  signInForgetMs: 10_000,
  /** W-8: failed sign-ins from all addresses per minute (default). */
  signInFailuresPerMinute: 20,
  /** Nesting depth of one call's arguments (the key guard's walk). */
  argumentDepth: 32,
  /** HTTP request line and headers. */
  maxHeaderBytes: 16_384,
  /** The longest request path served (others: 414). */
  maxPathUnits: 2048,
});

/**
 * The `GatewayPowers.extras` label of the gateway's in-process secret
 * writer (A-11; `GatewayContext.secretWriter()`): a page writes a secret
 * value through it, never through the hub.
 */
export const secretWriterLabel = 'secretWriter';

/**
 * The `GatewayPowers.extras` label of the subscription sign-in service
 * (`GW/extensions/subscription-signin.js`): the Subscriptions panel's
 * "Add account" and "Sign in again".
 */
export const subscriptionSignInLabel = 'subscriptionSignIn';

/** WebSocket close codes the gateway uses (4000-4999: application). */
export const closeCodes = Object.freeze({
  /** The operator rotated the sign-in secret. */
  signInRotated: 4001,
  /** A frame that is not CapTP JSON (text frame, bad JSON, bad UTF-8). */
  protocol: 4002,
  /** No successful `fetch` within `signInDeadlineMs`. */
  signInDeadline: 4003,
  /** `exportsPerConnection` exceeded. */
  tooManyObjects: 4008,
  /** The gateway registration was stopped or replaced. */
  gatewayStopped: 4010,
});

/** Texts the gateway answers or closes with (m3-interfaces.md 14). */
export const gatewayTexts = Object.freeze({
  /** Frame guard (architecture 7): a call into a vat over frameBytes. */
  messageTooLarge: 'message too large; use the composer',
  /** Key guard (architecture 7, rule 12.10). */
  unexpectedField: 'unexpected field',
  /**
   * Method-name guard (M3-FIX): a method, property or passable symbol name
   * that no contract interface declares, sent toward a vat.
   */
  unknownMethod: 'unknown method',
  /** A call carrying an object or promise the browser exported. */
  browserObject: 'objects made by the page cannot be sent to the daemon',
  /**
   * X-FIX: a call toward a vat carrying a gateway object that never leaves
   * the gateway (the page's secret writer).
   */
  gatewayObject: 'this gateway object cannot be sent to the daemon',
  /** `callsInFlight` exceeded. */
  tooManyCalls: 'too many calls in flight on this connection',
  /** Arguments nested deeper than `argumentDepth`. */
  tooDeep: 'arguments nested too deeply',
  /** A call before `fetch` succeeded, or to an unknown target. */
  notSignedIn: 'not signed in',
  /** R6-10, R7-48: HTTP 400 body for configuration in the query string. */
  queryConfig:
    'Configuration in the query string is not accepted; use the URL fragment',
  /** HTTP 403 body: the upgrade's Origin is not the configured origin. */
  originRefused: 'Origin not allowed',
  /** HTTP 404 body (upgrade on another path, or no such asset). */
  notFound: 'Not found',
  /** HTTP 503 body while the UI assets are not built. */
  uiNotBuilt: 'The chat UI is not built; run node ui/build.mjs',
  /** Close reasons. */
  signInRotated: 'the sign-in secret was rotated',
  tooManyObjects: 'this page holds too many objects; reloading',
  gatewayStopped: 'the gateway stopped',
});

/**
 * The strict Content-Security-Policy of the shell and assets (W-15; a
 * departure from R7-47, owner decision 2). Extensions add sources per
 * directive (`GatewayExtension.csp`); nothing removes one.
 */
export const cspDirectives = Object.freeze({
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
});

/** R6-14: reconnect delays, then every 30 s; reset after a good connect. */
export const reconnectDelaysMs = Object.freeze([
  0, 1000, 2000, 5000, 10_000, 30_000,
]);
/** R6-12: a connect attempt (open + fetch) gives up after this. */
export const connectDeadlineMs = 15_000;
/** R6-61: the sidebar becomes a drawer at this width or less. */
export const drawerMaxWidthPx = 640;

/**
 * UI slots a feature may fill (m3-interfaces.md 6.2). A slot name is a
 * page-internal label (F.2 d), fixed here; adding a slot is a contract
 * change.
 */
export const uiSlots = Object.freeze([
  /**
   * A global section of the Settings view (Subscriptions, Secrets, Presets,
   * Voice), listed by `label` in its section list and opened from the
   * header's Settings control.
   */
  'app.panel',
  /** A chip in the header of the active session (Network, Details). */
  'header.chip',
  /** A chip in the status bar (account chips). */
  'statusbar.chip',
  /**
   * Composer helpers (@-mention autocomplete, voice); props
   * `ComposerAddonProps`, optional `send` override.
   */
  'composer.addon',
  /** Controls inside the compose bar, before Send (the voice mode switch). */
  'composer.action',
  /** Extra fields of the "Start a new session" dialog (internet toggle). */
  'newSession.field',
  /**
   * Parts of the Settings view's "This session" section (emergency stop),
   * listed only for an open session and once one of them renders
   * something (a component may answer `null`).
   */
  'session.settings',
  /**
   * Per-turn renderers under the turn's user message (attachment chips,
   * widgets, mail captions); props `MessageRendererProps`.
   */
  'message.renderer',
  /** Actions beside an individual committed assistant message bubble. */
  'message.action',
]);

/** Browser-visible texts of M3's UI (m3-interfaces.md 14; spec R6-*). */
export const uiTexts = Object.freeze({
  pageTitle: 'Familiar',
  gatewayNotConfigured: 'Gateway not configured',
  queryConfigRefused:
    'Configuration in the query string is not accepted; open the link with #gateway=...&agent=...',
  reconnecting: 'Reconnecting…',
  serverStarting: 'Server starting...',
  signInRefused: 'Sign-in refused',
  noWebLocks:
    'This browser cannot send messages exactly once (it has no Web Locks). Update it to a current version.',
  sessions: 'Sessions',
  newSession: 'New session',
  noSessions: 'No sessions yet',
  startNewSession: 'Start a new session',
  newChatTitle: 'New chat',
  factoryDefault: 'Factory default',
  lastModelList: 'Showing the last available model list.',
  accountsUnreachable: 'Some accounts could not be reached.',
  composerPlaceholder: 'Message Floot…',
  send: 'Send',
  stop: '■ Stop',
  sendNow: 'Send now',
  edit: 'Edit',
  delete: 'Delete',
  cancel: 'Cancel',
  sendAgain: 'Send again',
  turnFailed: 'This turn did not finish.',
  turnStopped: 'This turn was stopped.',
  turnInterrupted: 'This turn was interrupted.',
  details: 'Details',
  recoveryTitle: 'Turn journal and recovery',
  recordAcknowledgement: 'Record acknowledgement',
  thinking: 'thinking',
});

/** Templated UI texts. */
export const uiTextOf = Object.freeze({
  /** @param {string} title */
  confirmDelete: title => `Delete "${title}"?`,
  /** @param {string} title */
  renameSession: title => `Rename "${title}"`,
  /** @param {string} title */
  deleteSession: title => `Delete "${title}"`,
  /**
   * R6-36 second line.
   * @param {number} messages
   * @param {number} queued
   */
  rowCounts: (messages, queued) => `${messages} messages · ${queued} queued`,
  /**
   * R6-52 status bar.
   * @param {number} up input + cached + cache-write tokens
   * @param {number} down output + reasoning tokens
   * @param {number} percent context share, 0-100
   */
  usage: (up, down, percent) => `↑${up} ↓${down} · ctx ${percent}%`,
  /**
   * R6-45 group header; seconds since the group started.
   * @param {number} seconds
   * @param {boolean} running
   */
  thoughtFor: (seconds, running) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const elapsed = `${m}m${s}s`;
    return running ? elapsed : `Thought for ${elapsed}`;
  },
  /**
   * R6-51 other failures in the status bar.
   * @param {string} message
   */
  statusError: message => `error: ${message}`,
});

// ---------------------------------------------------------------- hook types

/**
 * What the gateway gives an extension (m3-interfaces.md 6.1). Objects of
 * this adapter incarnation; none is a vat facet.
 *
 * @typedef {object} GatewayContext
 * @property {any} live the incarnation's `Live`
 * @property {any} composer the incarnation's `Composer`
 * @property {any} content the incarnation's `Content`
 * @property {() => any} history the incarnation's `History`
 * @property {(callback: () => void) => void} whenAttached runs once the
 *   agent host is attached (blobs and secrets work from then on)
 * @property {() => Promise<any>} secretWriter the incarnation's in-process
 *   secret writer (A-11): a gateway-local exo, `replace(secret, value |
 *   SealedBox, expectedGeneration?)` and `publicKey()`, calling M2's
 *   `replaceLocal` (`AH/secrets/writer.js`); the same object every page
 *   finds in `GatewayPowers.extras` under `secretWriterLabel`. It is not
 *   the hub's `SecretWriter` (`SecretsAdmin.openWriter()`), which takes a
 *   `SealedBox` only. Call it only after `whenAttached`; before that it
 *   rejects. M4's `GW/extensions/secrets.js` resolves its
 *   `LargeCall.target` with it
 * @property {string} stateDir the daemon's state directory (read only)
 * @property {(event: Record<string, unknown>) => void} log a structured
 *   line; never a message body, secret or fragment
 * @property {() => any} [operator] the `Operator` presence of the current
 *   bind (the factory vat's; `undefined` before the first bind), as a
 *   signed-in page receives it (M11's speech host reads `getVoice()`);
 *   always present on the gateway's own context (`GW/index.js`)
 * @property {(grant: any) => Promise<string>} [readGrant] only on the
 *   context of an extension `GW/index.js` was given powers for
 *   (`ExtensionPowers`, compared by the extension object's identity;
 *   m11-interfaces.md D-M11-22): reads a key through its `ReadGrant` in
 *   this process. Every other extension's context has no `readGrant`
 * @property {SignInPowers} [signInPowers] only on the context of the
 *   subscription sign-in extension (`GW/extensions/subscription-signin.js`,
 *   listed by object in `extensionPowers` as the speech extension is)
 */

/**
 * What the subscription sign-in extension needs of the adapter
 * (`AH/index.js`): the adapter's `Accounts`, the store accessor of an
 * active pool member (`AH/subscriptions/index.js` `memberAccess`), and the
 * adapter's `fetch` (tests: a fake provider's).
 *
 * @typedef {object} SignInPowers
 * @property {() => any} accounts
 * @property {(pool: any, member: any) => Promise<{ provider: 'claude' | 'codex', label: string, access: any }>} memberAccess
 * @property {typeof globalThis.fetch} [fetch]
 */

/**
 * Extra context fields for one extension, given to `makeGatewayService` by
 * the adapter (`AH/index.js`). `extension` is the very `gatewayExtension`
 * object the adapter imported; the loader's object for the same file is
 * that object (Node's `require` of an ES module shares the module cache),
 * so the object, not a file or extension name, picks the receiver.
 *
 * @typedef {object} ExtensionPowers
 * @property {GatewayExtension} extension
 * @property {{ readGrant?: (grant: any) => Promise<string>, signInPowers?: SignInPowers }} powers
 */

/**
 * One HTTP route or WebSocket upgrade route an extension serves (M11
 * `/audio`). `path` is matched exactly; `/`, `/ws` and `/assets/*` are the
 * gateway's own and cannot be taken.
 *
 * An `upgrade` route's `handle` receives a fourth argument, `accept(request,
 * raw, head, { maxMessageBytes, onSocket })`: the gateway's handshake and
 * connection counts (M11 seam H5), answering the accepted `GatewaySocket`
 * (`server.js`) or `undefined` when it refused (the refusal written and
 * logged). The path and Origin are checked before `handle` is called.
 *
 * @typedef {object} GatewayRoute
 * @property {'http' | 'upgrade'} kind
 * @property {string} path
 * @property {(request: any, socketOrResponse: any, head?: any, accept?: UpgradeAccept) => void | Promise<void>} handle
 */

/**
 * @callback UpgradeAccept
 * @param {any} request
 * @param {any} raw
 * @param {any} head
 * @param {{ maxMessageBytes: number, onSocket: (socket: any) => void }} options
 * @returns {any} the accepted `GatewaySocket`, or `undefined` (refused)
 */

/**
 * A gateway-local service a signed-in page receives in
 * `GatewayPowers.extras` (labelled; F.2 d: the page finds its feature's
 * service by that label).
 *
 * @typedef {object} GatewayService
 * @property {string} label
 * @property {(context: GatewayContext) => any} make called once per
 *   adapter incarnation; answers an exo with an interface guard
 */

/**
 * A method of a gateway-local object that may take arguments over
 * `frameBytes` (the frame guard exempts it; `wsMessageBytes` still holds).
 * The Composer's `submit` and `edit` are M3's own.
 *
 * @typedef {object} LargeCall
 * @property {(context: GatewayContext) => Promise<any>} target resolves
 *   the local object once per incarnation (identity is compared)
 * @property {string[]} methods
 */

/**
 * The named export `gatewayExtension` of `AH/gateway/extensions/<name>.js`
 * (a synchronous ES module: no top-level await, J-0519). Files are loaded
 * in name order at adapter start; a file that throws, or has no
 * `gatewayExtension` export, is logged and skipped, never fatal.
 *
 * @typedef {object} GatewayExtension
 * @property {string} name
 * @property {GatewayService[]} [services]
 * @property {GatewayRoute[]} [routes]
 * @property {LargeCall[]} [largeCalls]
 * @property {Record<string, string[]>} [csp] sources added per directive
 */

/**
 * One UI feature (m3-interfaces.md 6.2). The export `feature` of
 * `ui/src/<dir>/feature.js` is one `UiFeature` or an array of them (one
 * directory may fill several slots, e.g. a panel and a status-bar chip).
 * Collected by `ui/build.mjs` in directory-name order, array order within
 * a file; a duplicate `id` fails the build.
 *
 * Props by slot (`component`):
 * - `composer.addon`: `ComposerAddonProps`;
 * - `message.renderer`: `MessageRendererProps`;
 * - `message.action`: `{ context, message }`, the displayed assistant message;
 * - every other slot: `{ context }`.
 *
 * @typedef {object} UiFeature
 * @property {string} id unique over all features: the directory name, or
 *   `<dir>.<part>` when a file exports several
 * @property {string} slot one of `uiSlots`
 * @property {string} [label] menu or chip text
 * @property {number} [order] within the slot (default 100)
 * @property {(context: FeatureContext) => boolean} [when] shown only when
 *   true (default: always)
 * @property {(props: any) => any} component a Preact component (props as
 *   above)
 * @property {(request: ComposerSendRequest) => Promise<any> | undefined} [send]
 *   `composer.addon` only: a submission override. Addons are asked in slot
 *   order; the first whose `send` answers a promise sends instead of
 *   `Composer.submit` (its promise answers the `Receipt`); `undefined`
 *   passes to the next addon, and after the last one the controller calls
 *   `Composer.submit(session, text, requestId)`. A rejection keeps the
 *   draft and shows the error's message in the composer's status line
 */

/**
 * What a `composer.addon` component receives. `input` is the composer's
 * current text and caret (UTF-16 offsets), re-rendered on every change;
 * `replaceRange` replaces the input from `start` up to (not including)
 * `end` and puts the caret after the inserted text (a mention
 * completion).
 *
 * @typedef {object} ComposerAddonProps
 * @property {FeatureContext} context
 * @property {{ text: string, caret: number }} input
 * @property {(start: number, end: number, text: string) => void} replaceRange
 */

/**
 * The argument of `UiFeature.send`. `resend` is true when the controller
 * resends a saved draft after a reconnect or reload; it does so only after
 * `E(session).getSubmissionReceipt(requestId)` answered none, and through
 * the same addon chain as the first send (m3-interfaces.md 9.2).
 *
 * @typedef {object} ComposerSendRequest
 * @property {FeatureContext} context
 * @property {any} session the `Session` presence
 * @property {string} text
 * @property {string} requestId
 * @property {boolean} resend
 * @property {true} [spoken] sent from spoken mode (m11-interfaces.md 9.1):
 *   an addon that submits passes `spoken: true` in `Composer.submit`'s
 *   options
 * @property {true} [dictated] its text came from dictation (9.1): passed
 *   on the same way
 */

/**
 * What a `message.renderer` component receives, once per turn of the
 * conversation, rendered under that turn's user message.
 * `turn` is the controller's entry for the turn (`turnId`; `turn`, the
 * `Turn` presence, absent for archived turns; `status`, the last
 * `TurnStatus` seen). `record` is the turn's `TurnStarted` record exactly
 * as a history page (`Session.getHistoryPage`, `History.page`) delivered
 * it; for a turn the page saw start live and has not yet re-read from a
 * page, it is the `turn-start` `VatEvent` as delivered (`type` instead of
 * `kind`). Either way every optional field a later milestone adds is kept
 * (M5's `attachments`): the controller never projects records onto M2's
 * keys. A renderer with nothing to show returns null.
 *
 * @typedef {object} MessageRendererProps
 * @property {FeatureContext} context
 * @property {{ turnId: string, turn?: any, status?: any }} turn
 * @property {Record<string, any>} record
 */

/**
 * What a feature receives (m3-interfaces.md 6.2).
 *
 * @typedef {object} FeatureContext
 * @property {any} powers the `GatewayPowers` presences of this connection
 * @property {(label: string) => any} extra the extras service of that label
 * @property {any} controller read-only state and actions (UiController)
 * @property {(fn: () => Promise<unknown>) => Promise<unknown>} call runs a
 *   daemon call and reports a failure in the status bar
 */
