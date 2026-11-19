// @ts-check
/**
 * The interface table of the environments native resource (M6 contract,
 * `designs/m6-interfaces.md` sections 3 and 4): the guards, record shapes,
 * method name lists, bounds and fixed texts of the objects its manager vat
 * and its adapter make. One resource holds a session's git workspace and
 * its development container (D-M6-1).
 *
 * Who reads it: the environments manager vat (`resources/environments/
 * durable.js`, bundled at installation) and its adapter
 * (`resources/environments/impl/`, Node). No harness vat program imports
 * it: the session and the factory hold these objects as remotables and
 * call them; the few entries they need (the `Session` methods of emergency
 * stop, `ExecutionState`, the `SessionServices` keys, the shell tool
 * descriptions, the export page's `execution`) are added to
 * `guards/session.js` and `guards/factory.js` by the cross-lane seam unit
 * WX.1 (contract section 15). The gateway never reaches these objects:
 * `guest/lib/vocabulary-tables.js` lists this module in
 * `vocabularyExclusions` as not browser-sendable (D-M6-10, seam V-1).
 *
 * Rules (architecture 3, 9, 12): every record that crosses is closed
 * (`record`), every string and list bounded; no data-dependent record key
 * crosses into the manager vat (paths, branch names and file names are
 * values, never keys); every answer the adapter sends toward a vat fits
 * `environmentLimits.answerBytes` by the sender's own check (`fitsFrame`),
 * because a guard runs after decoding.
 *
 * Runs in the manager vat (prelude globals) and in Node: a Node process
 * installs the guest prelude before importing it
 * (`scripts/guest-prelude.js` `installGuestPrelude()`).
 *
 * Changing an existing entry is a contract change (subject
 * `contract(thixotrope-harness): ...`, `m6-interfaces.md` in the same
 * commit).
 */
import { limits } from '../limits.js';
import {
  text,
  list,
  record,
  count,
  staged,
  R,
  done,
  lazyTable,
  shapes as baseShapes,
} from './base.js';
// M8's image bounds (seam X-1): `openImage` takes the path M8's image tool
// checked, by the same rule (imported, not copied: review rule 3).
import { imageLimits } from './images.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

// ---------------------------------------------------------------- bounds

/**
 * Bounds read only by this resource (manager vat and adapter). Bounds a
 * harness vat program reads live in `guest/lib/limits.js`; none of these
 * does. Evidence in brackets; `[spec]` is the spec default kept.
 */
export const environmentLimits = harden({
  /**
   * Largest answer (estimated UTF-8 bytes, units x 3) the adapter sends
   * toward a vat for one Git or Shell call: two thirds of `frameBytes`, so
   * the answer and its envelope stay under the 24,576-byte string bound and
   * far under the hub's 65,536-byte frame ceiling (J-10125, J-10126). A
   * larger result is cut and says so (`truncated`, `next`).
   */
  answerBytes: 16_384,
  /** Environments one manager keeps (one per session that has one). */
  maxEnvironments: 1024,
  /** Releases and stops the manager keeps owing an adapter at once. */
  maxPendingWork: 1024,
  /** Programs on a shell allowlist; units per program name. */
  maxAllowedCommands: 32,
  commandNameUnits: 64,
  /** argv entries after the program, and units per entry (model data). */
  maxCommandArgs: 1024,
  commandArgUnits: 32_768,
  /**
   * The arguments of one command together, UTF-8 bytes, checked by the
   * adapter after parsing the model's JSON (R4-43): above it the call is
   * refused, nothing runs.
   */
  commandArgsBytes: 262_144,
  /** R3-47 [spec]: default per-call timeout, 24 h. */
  defaultCommandTimeoutMs: 86_400_000,
  /** R3-47, exo-shell: the largest timeout a call may ask (timer range). */
  maxCommandTimeoutMs: 2_147_483_647,
  /** R3-47 [spec]: grace between SIGTERM and SIGKILL. */
  killGraceMs: 2000,
  /** R3-47 [spec]: output kept per stream before the common cut. */
  streamBytes: 65_536,
  /**
   * The exec-path answer (`Shell.runCommand` through the manager): each
   * stream cut so the whole record fits `answerBytes`.
   */
  shellAnswerStreamUnits: 2560,
  /** D-16: an environment's container stops after this long without commands. */
  idleStopMs: 900_000,
  /** Image pin: `<repository>@sha256:<64 hex>` (R8-41, R8-42). */
  imagePinUnits: 512,
  /** Memory, processes and CPUs of one container (W-12; owner question O-4). */
  defaultMemoryBytes: 4 * 1024 * 1024 * 1024,
  defaultPids: 1024,
  defaultCpus: 2,
  /** Git: branch and revision names, paths, path lists, messages. */
  gitRefUnits: 255,
  gitPathUnits: 4096,
  maxGitPaths: 256,
  gitMessageUnits: 16_384,
  /** Git: entries per page of `status`, `log`, `branches`, `stashList`. */
  gitStatusEntries: 1000,
  gitLogEntries: 50,
  gitBranchEntries: 256,
  gitStashEntries: 64,
  /** Git: units of one text field of an answer (diff text, subject). */
  gitTextUnits: 4800,
  gitSubjectUnits: 200,
  gitAuthorUnits: 120,
  /** A commit object id (SHA-1 or SHA-256 hex). */
  oidUnits: 64,
  /** Help text of one method or the overview (`describeCapability`). */
  helpUnits: 4000,
});

// ---------------------------------------------------------------- names

/** Programs a shell may run by default (R3-44 [spec], A.3). */
export const defaultAllowedCommands = harden([
  'sh',
  'bash',
  'curl',
  'git',
  'node',
  'npm',
  'python3',
  'cargo',
  'rustc',
  'rustup',
]);

/** Container runtimes the adapter drives (D-M6-8). */
export const runtimeKinds = harden(['fake', 'podman', 'docker']);

/** What a session's environment holds (template object kinds, M5). */
export const environmentObjectKinds = harden([
  'git-workspace',
  'development-environment',
]);

/** Execution states of a session (Fae `projectExecution`; R4-8, R6-57). */
export const executionStates = harden(['running', 'stopping', 'stopped']);

/**
 * Git methods of the writer facet (R3-247 as P-19 needs it; contract 3.4).
 * `read` and `help` make it a `SourceReader` and a describable capability.
 */
export const gitWriterMethodNames = harden([
  'status',
  'diff',
  'log',
  'branches',
  'currentBranch',
  'trackingStatus',
  'stashList',
  'read',
  'openImage',
  'help',
  'add',
  'restore',
  'commit',
  'createBranch',
  'switchBranch',
  'renameBranch',
  'deleteBranch',
  'merge',
  'stashPush',
  'stashPop',
  'readOnly',
]);

/** Git methods of the read-only facet (R3-247 "attenuation"). */
export const gitReaderMethodNames = harden([
  'status',
  'diff',
  'log',
  'branches',
  'currentBranch',
  'trackingStatus',
  'stashList',
  'read',
  'openImage',
  'help',
]);

/**
 * Methods no Git facet of a session has (R3-248): history rewriting and
 * remotes. Acceptance 5 checks none of them is a method of either facet.
 */
export const gitAbsentMethodNames = harden([
  'amend',
  'reword',
  'rebase',
  'cherryPick',
  'reset',
  'push',
  'pull',
  'fetch',
  'clone',
  'setUpstream',
  'addRemote',
  'config',
]);

/** Shell methods (exo-shell's `exec` is `runCommand`, A.3). */
export const shellMethodNames = harden(['runCommand', 'inspect', 'help']);

/** The operations the manager forwards to the adapter's ops facet. */
export const gitOps = harden([
  'status',
  'diff',
  'log',
  'branches',
  'currentBranch',
  'trackingStatus',
  'stashList',
  'read',
  'add',
  'restore',
  'commit',
  'createBranch',
  'switchBranch',
  'renameBranch',
  'deleteBranch',
  'merge',
  'stashPush',
  'stashPop',
]);

// ---------------------------------------------------------------- texts

/**
 * Fixed texts. Fae's words where the spec quotes or cites them (source in
 * the comment, `1315bef86`); the harness's own otherwise.
 */
export const environmentTexts = harden({
  tooManyEnvironments: 'Too many environments: delete sessions that have one first',
  /** R3-21 (Fae session-factory.js:3911-3922, reworded without backends). */
  runnerRequired:
    'A preset that provisions a shell needs a configured environment runner',
  /** R8-42: the configured runtime refused its image pin. */
  imageRefused:
    'The environment image is not available: its pin is not a digest or the image is missing locally',
  /** The resource is installed but not configured yet. */
  notConfigured: 'The environment runner is not configured',
  /** Every Shell and Git call of a released environment. */
  released: 'This environment was released with its session',
  /** Shell and Git calls while the session is emergency-stopped (R4-8, R6-50). */
  stopped: 'Session is stopped or stopping; explicitly resume it in Settings',
  /** Fae: resume while a stop is still in progress. */
  finishStopFirst: 'Finish emergency stop before resuming',
  /** Fae: a stop that did not complete (the state stays `stopping`). */
  stopIncomplete: 'Session stop incomplete; retry in Settings',
  /** R4-8: emergency stop on a session without a shell. */
  noEnvironmentToStop: 'This session has no shell environment to stop',
  /** The read-only Git facet refuses a write (R3-247 attenuation). */
  gitReadOnly: 'This Git facet is read-only',
  /** Git: a path that leaves the worktree, or names `.git`. */
  gitPathRefused:
    'Paths are relative to the workspace and may not leave it or name .git',
  /** Git: a branch or revision name refused before git sees it. */
  gitRefRefused:
    'A branch or revision name may not start with "-" and must be a valid ref name',
  /** Git (`@endo/git`): repository config that could run code on the host. */
  gitConfigRefused:
    'The repository configuration names a filter, merge driver or include; remove it before writing',
  /** exo-shell `Shell.exec` (R3-44). */
  timeoutInvalid: 'timeoutMs must be a positive timer-range integer',
  /**
   * D-M6-5: a write forwarded by the manager whose adapter call broke (the
   * runner restarted); writes are never retried.
   */
  outcomeUnknown:
    "The workspace operation's outcome is unknown: the environment runner restarted while it ran. Check status before retrying.",
});

/** Fixed texts with parameters. */
export const environmentTextOf = harden({
  /**
   * exo-shell (R3-44): a program not on the allowlist.
   * @param {string} command
   */
  notAllowed: command =>
    `Shell.exec: command ${JSON.stringify(command)} is not in the allowlist`,
  /**
   * exo-shell (R3-47): the timeout fired; SIGTERM, then SIGKILL after the
   * grace.
   * @param {number} ms
   */
  timedOut: ms => `Shell command timed out after ${ms}ms`,
  /**
   * The runtime failed to start or reach the container.
   * @param {string} reason a bounded reason, never a host path
   */
  runtimeFailed: reason =>
    `The environment could not run the command: ${reason}`,
  /**
   * The command's arguments over `commandArgsBytes`.
   * @param {number} bytes
   * @param {number} limit
   */
  argsTooLarge: (bytes, limit) =>
    `Command arguments too large (${bytes} bytes; limit ${limit})`,
});

// ---------------------------------------------------------------- shapes

const L = environmentLimits;

const shapeBuilders = {
  /** One allowlisted program name (no `/`: names, not paths). */
  CommandName: () => text(L.commandNameUnits),
  /** `<repository>@sha256:<64 hex>`; the adapter re-checks the form. */
  ImagePin: () => text(L.imagePinUnits),
  /**
   * `EnvironmentsAdmin.configure` (operator, provisioning): what the
   * service registration's spec carries to every adapter incarnation
   * (D-M6-3: install-time configuration through the spec).
   */
  EnvironmentSettings: () =>
    record(
      {
        runtime: M.or(...runtimeKinds),
        allowedCommands: list(S.CommandName, L.maxAllowedCommands),
      },
      {
        image: S.ImagePin,
        defaultTimeoutMs: M.and(count, M.lte(L.maxCommandTimeoutMs)),
        idleStopMs: count,
        memoryBytes: count,
        pids: count,
        cpus: count,
      },
    ),
  /** `EnvironmentsAdmin.status()`. */
  EnvironmentsStatus: () =>
    record(
      {
        state: M.or('unconfigured', 'ready', 'refused'),
        environments: count,
        pendingStops: count,
        pendingReleases: count,
      },
      {
        runtime: M.or(...runtimeKinds),
        error: baseShapes.Reason,
        running: count,
      },
    ),
  /** `EnvironmentsAdmin.provide` argument: which objects the preset selects. */
  EnvironmentRequest: () =>
    record({ workspace: M.boolean(), shell: M.boolean() }),
  /** `EnvironmentsAdmin.provide` answer. A shell always comes with a workspace. */
  EnvironmentKit: () =>
    record(
      { control: R('EnvironmentControl') },
      { workspace: R('Git'), shell: R('Shell') },
    ),
  /** `EnvironmentControl.describe()`. */
  EnvironmentInfo: () =>
    record({
      workspace: M.boolean(),
      shell: M.boolean(),
      stopped: M.boolean(),
      released: M.boolean(),
    }),
  /** `Shell.inspect()` (A.3 `inspectShell`): never a host path. */
  ShellInfo: () =>
    record({
      allowedCommands: list(S.CommandName, L.maxAllowedCommands),
      timeoutMs: count,
      maxOutputBytes: count,
    }),
  /** `Shell.runCommand` options (exo-shell `ExecOptions`). */
  CommandOptions: () =>
    record({}, { timeoutMs: M.and(count, M.lte(L.maxCommandTimeoutMs)) }),
  /**
   * `Shell.runCommand` answer on the exec path (A.3): each stream cut to
   * `shellAnswerStreamUnits`, `truncated` true when either was cut here or
   * by the 64 KiB stream bound.
   */
  CommandResult: () =>
    record({
      stdout: text(L.shellAnswerStreamUnits),
      stderr: text(L.shellAnswerStreamUnits),
      exitCode: M.or(M.number(), M.null()),
      signal: M.or(text(16), M.null()),
      truncated: M.boolean(),
    }),
  /**
   * `ShellPort.runCommand` / `inspect` argument (the session's tool path):
   * the model's argument JSON as text (a vat never parses it, R4-43), the
   * agent-host writers for a staged result and its `Content` for staged
   * arguments, and the op id the adapter logs.
   */
  ShellPortRequest: () =>
    record(
      {
        opId: text(limits.idUnits),
        args: staged(text(limits.inlineBytes)),
        writers: R('BlobWriters'),
      },
      { content: R('Content') },
    ),

  // ---- Git ----

  GitRef: () => text(L.gitRefUnits),
  GitPath: () => text(L.gitPathUnits),
  GitPaths: () => list(S.GitPath, L.maxGitPaths),
  /** `status(options?)` (R3-247: untracked mode, count limit). */
  GitStatusRequest: () =>
    record(
      {},
      {
        untracked: M.or('no', 'normal', 'all'),
        limit: M.and(count, M.lte(L.gitStatusEntries)),
        paths: S.GitPaths,
      },
    ),
  /** One path's state: porcelain v2 letters (`.` for unchanged). */
  GitStatusEntry: () =>
    record(
      { path: S.GitPath, index: text(1), worktree: text(1) },
      { from: S.GitPath },
    ),
  GitStatus: () =>
    record({
      branch: M.or(S.GitRef, M.null()),
      entries: list(S.GitStatusEntry, L.gitStatusEntries),
      truncated: M.boolean(),
    }),
  /** `diff(options?)`: unstaged by default; staged; or between revisions. */
  GitDiffRequest: () =>
    record(
      {},
      {
        staged: M.boolean(),
        from: S.GitRef,
        to: S.GitRef,
        paths: S.GitPaths,
        stat: M.boolean(),
      },
    ),
  GitDiff: () => record({ text: text(L.gitTextUnits), truncated: M.boolean() }),
  /** `log(options?)`: newest first; `after` continues a page. */
  GitLogRequest: () =>
    record(
      {},
      {
        from: S.GitRef,
        limit: M.and(count, M.lte(L.gitLogEntries)),
        after: text(L.oidUnits),
        since: count,
        until: count,
      },
    ),
  GitCommit: () =>
    record({
      oid: text(L.oidUnits),
      subject: text(L.gitSubjectUnits),
      author: text(L.gitAuthorUnits),
      time: count,
    }),
  GitLog: () =>
    record(
      { commits: list(S.GitCommit, L.gitLogEntries), truncated: M.boolean() },
      { next: text(L.oidUnits) },
    ),
  GitBranches: () =>
    record({
      branches: list(
        record({ name: S.GitRef, current: M.boolean(), oid: text(L.oidUnits) }),
        L.gitBranchEntries,
      ),
      truncated: M.boolean(),
    }),
  /** R3-248: a session workspace has no upstream. */
  GitTracking: () =>
    record({
      branch: M.or(S.GitRef, M.null()),
      upstream: M.null(),
      ahead: count,
      behind: count,
      detached: M.boolean(),
    }),
  GitStashes: () =>
    record({
      stashes: list(
        record({ index: count, message: text(L.gitSubjectUnits) }),
        L.gitStashEntries,
      ),
      truncated: M.boolean(),
    }),
  GitRestoreOptions: () => record({}, { staged: M.boolean() }),
  GitCreateBranchOptions: () =>
    record({}, { startPoint: S.GitRef, switchAfterCreate: M.boolean() }),
  GitDeleteBranchOptions: () => record({}, { force: M.boolean() }),
  /** R3-247: fast-forward only, or always a merge commit. */
  GitMergeOptions: () =>
    record(
      {},
      { mode: M.or('ff-only', 'merge-commit'), message: S.GitMessage },
    ),
  GitMessage: () => text(L.gitMessageUnits),
  /** The answer of every write: the branch and head after it. */
  GitWriteResult: () =>
    record(
      {
        branch: M.or(S.GitRef, M.null()),
        head: M.or(text(L.oidUnits), M.null()),
      },
      { conflicts: S.GitPaths },
    ),
  /**
   * `EnvironmentsOps.git` argument: one operation and its arguments as the
   * Git exo received them (already guarded there), in a list (positional,
   * no record keys from the caller).
   */
  GitOpRequest: () => record({ op: M.or(...gitOps), args: list(M.any(), 4) }),
  /** The pending work the manager owes a new adapter incarnation. */
  PendingWork: () =>
    record({
      stops: list(text(limits.idUnits), L.maxPendingWork),
      releases: list(text(limits.idUnits), L.maxPendingWork),
      // Emergency-stopped environments (D-M6-9): a new incarnation refuses
      // their ShellPort and ImageSource calls from its first call.
      withdrawn: list(text(limits.idUnits), L.maxEnvironments),
    }),
  /**
   * `openImage(path)` argument (seam X-1): the segments M8's image tool
   * checked (`image-guards.js` `ImagePath`); the adapter applies the
   * workspace path rules again (worktree only, never `.git`).
   */
  ImagePath: () =>
    list(text(imageLimits.segmentUnits), imageLimits.pathSegments),
  /** `EnvironmentsOps.stop` options: `withdraw` for an emergency stop. */
  StopOptions: () => record({}, { withdraw: M.boolean() }),
};

/**
 * Every shape of this resource, built on first use (`lazyTable`), with
 * the shapes of `guards/base.js` (`StagedText`, `ToolOutcome`, `Reason`,
 * ...) readable through it.
 */
export const environmentShapes = lazyTable(shapeBuilders, baseShapes);
/** Shorthand inside this module. */
const S = environmentShapes;

// ---------------------------------------------------------------- interfaces

/** The read methods both Git facets have. */
const gitReadGuards = () => ({
  status: M.callWhen().optional(S.GitStatusRequest).returns(S.GitStatus),
  diff: M.callWhen().optional(S.GitDiffRequest).returns(S.GitDiff),
  log: M.callWhen().optional(S.GitLogRequest).returns(S.GitLog),
  branches: M.callWhen().returns(S.GitBranches),
  currentBranch: M.callWhen().returns(M.or(S.GitRef, M.null())),
  trackingStatus: M.callWhen().returns(S.GitTracking),
  stashList: M.callWhen().returns(S.GitStashes),
  // M5's SourceReader protocol (readSources over the worktree).
  read: M.callWhen(baseShapes.SourceReadRequest).returns(
    baseShapes.SourceReadResult,
  ),
  // Seam X-1 (M8 `viewImage`): an adapter-side `ImageSource` (M8's guard,
  // `image-guards.js`) over one worktree file; its pages go adapter to
  // adapter and never through this manager vat.
  openImage: M.callWhen(S.ImagePath).returns(R('ImageSource')),
  help: M.call()
    .optional(text(limits.methodNameUnits))
    .returns(text(L.helpUnits)),
});

const interfaceBuilders = {
  /**
   * Manager vat: the installation's facet (inventory `environmentsAdmin`),
   * held by provisioning and the factory only.
   */
  EnvironmentsAdmin: () =>
    M.interface('EnvironmentsAdmin', {
      configure: M.callWhen(S.EnvironmentSettings).returns(
        S.EnvironmentsStatus,
      ),
      status: M.callWhen().returns(S.EnvironmentsStatus),
      provide: M.call(S.EnvironmentRequest).returns(S.EnvironmentKit),
      bindSession: M.call(R('EnvironmentControl'), R('Session')).returns(done),
      release: M.call(R('EnvironmentControl')).returns(done),
      releaseSession: M.call(R('Session')).returns(done),
    }),
  /**
   * Manager vat: the sink the service registration's spec carries; the
   * adapter's `bind` attaches its ops facet (D-7) and reports work done.
   */
  EnvironmentsSink: () =>
    M.interface('EnvironmentsSink', {
      attach: M.call(R('EnvironmentsOps'), text(128)).returns(S.PendingWork),
      stopped: M.call(list(text(limits.idUnits), L.maxPendingWork)).returns(
        done,
      ),
      released: M.call(list(text(limits.idUnits), L.maxPendingWork)).returns(
        done,
      ),
    }),
  /**
   * Adapter: the ops facet (one per incarnation); the manager vat is its
   * only caller. `key` is the manager's `e<n>` for one environment: it
   * leaves the object system here (directory and container names) and
   * never reaches a session or exec vat.
   */
  EnvironmentsOps: () =>
    M.interface('EnvironmentsOps', {
      status: M.callWhen().returns(S.EnvironmentsStatus),
      git: M.callWhen(text(limits.idUnits), S.GitOpRequest).returns(M.any()),
      runCommand: M.callWhen(
        text(limits.idUnits),
        S.CommandName,
        list(text(L.commandArgUnits), L.maxCommandArgs),
        S.CommandOptions,
      ).returns(S.CommandResult),
      inspect: M.callWhen(text(limits.idUnits)).returns(S.ShellInfo),
      openImage: M.callWhen(text(limits.idUnits), S.ImagePath).returns(
        R('ImageSource'),
      ),
      port: M.callWhen(text(limits.idUnits)).returns(R('ShellPort')),
      stop: M.callWhen(text(limits.idUnits))
        .optional(S.StopOptions)
        .returns(done),
      resume: M.callWhen(text(limits.idUnits)).returns(done),
      release: M.callWhen(text(limits.idUnits)).returns(done),
    }),
  /** Manager vat: the writer Git facet, bound in a session as `workspace`. */
  Git: () =>
    M.interface('Git', {
      ...gitReadGuards(),
      add: M.callWhen(S.GitPaths).returns(S.GitWriteResult),
      restore: M.callWhen(S.GitPaths)
        .optional(S.GitRestoreOptions)
        .returns(S.GitWriteResult),
      commit: M.callWhen(S.GitMessage).returns(S.GitWriteResult),
      createBranch: M.callWhen(S.GitRef)
        .optional(S.GitCreateBranchOptions)
        .returns(S.GitWriteResult),
      switchBranch: M.callWhen(S.GitRef).returns(S.GitWriteResult),
      renameBranch: M.callWhen(S.GitRef, S.GitRef).returns(S.GitWriteResult),
      deleteBranch: M.callWhen(S.GitRef)
        .optional(S.GitDeleteBranchOptions)
        .returns(S.GitWriteResult),
      merge: M.callWhen(S.GitRef)
        .optional(S.GitMergeOptions)
        .returns(S.GitWriteResult),
      stashPush: M.callWhen().optional(S.GitMessage).returns(S.GitWriteResult),
      stashPop: M.callWhen().returns(S.GitWriteResult),
      readOnly: M.call().returns(R('GitReader')),
    }),
  /** Manager vat: the read-only Git facet (one per environment). */
  GitReader: () => M.interface('GitReader', gitReadGuards()),
  /**
   * Manager vat: the shell, bound in a session as `shell` (exec code calls
   * it through the membrane; answers fit `answerBytes`).
   */
  Shell: () =>
    M.interface('Shell', {
      runCommand: M.callWhen(
        S.CommandName,
        list(text(L.commandArgUnits), L.maxCommandArgs),
      )
        .optional(S.CommandOptions)
        .returns(S.CommandResult),
      inspect: M.callWhen().returns(S.ShellInfo),
      help: M.call()
        .optional(text(limits.methodNameUnits))
        .returns(text(L.helpUnits)),
    }),
  /**
   * Adapter: the session's shell for one adapter incarnation (the tool
   * path, D-M6-4). Answers a `ToolOutcome` whose text is the A.3 JSON,
   * inline up to `inlineBytes`, else staged through the request's writers.
   */
  ShellPort: () =>
    M.interface('ShellPort', {
      runCommand: M.callWhen(S.ShellPortRequest).returns(
        baseShapes.ToolOutcome,
      ),
      inspect: M.callWhen(S.ShellPortRequest).returns(baseShapes.ToolOutcome),
    }),
  /**
   * Manager vat: the session's control of its own environment (never a
   * label: model code cannot reach it). The factory keeps no admin facet:
   * it releases by amplification (`EnvironmentsAdmin.release`,
   * `releaseSession`).
   */
  EnvironmentControl: () =>
    M.interface('EnvironmentControl', {
      describe: M.call().returns(S.EnvironmentInfo),
      port: M.callWhen().returns(R('ShellPort')),
      stop: M.callWhen().returns(done),
      emergencyStop: M.callWhen().returns(done),
      resume: M.call().returns(done),
    }),
};

/** Every interface guard of this resource, built on first use. */
export const environmentInterfaces = lazyTable(interfaceBuilders);

/** Method names per interface, in declaration order (tests, review). */
export const environmentMethodNames = harden({
  EnvironmentsAdmin: harden([
    'configure',
    'status',
    'provide',
    'bindSession',
    'release',
    'releaseSession',
  ]),
  EnvironmentsSink: harden(['attach', 'stopped', 'released']),
  EnvironmentsOps: harden([
    'status',
    'git',
    'runCommand',
    'inspect',
    'openImage',
    'port',
    'stop',
    'resume',
    'release',
  ]),
  Git: gitWriterMethodNames,
  GitReader: gitReaderMethodNames,
  Shell: shellMethodNames,
  ShellPort: harden(['runCommand', 'inspect']),
  EnvironmentControl: harden([
    'describe',
    'port',
    'stop',
    'emergencyStop',
    'resume',
  ]),
});
