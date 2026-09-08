// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop */

// Floot — a streaming agent harness for the Endo daemon.
//
// Floot mirrors fae's factory/driver/guest topology (see @endo/fae) but trades
// fae's mailbox-driven, fully-buffered reply for a *pull-based streaming*
// interface: a session exposes `startTurn(text) -> FlootTurn`, whose `watch()`
// yields a Far StreamReader (src/stream.js) of reply-token deltas as the LLM
// produces them. This is the same wire the voice Space already consumes for
// transcripts (audio-server-caplet.js), so a client can stream the assistant's
// reply token-by-token and (later) feed it to TTS. The turn itself belongs to
// the daemon (src/session-turn.js): watching is how a client sees it, not what
// keeps it alive.
//
// Persistence and provisioning match fae: per-session conversation history lives
// in the session guest's petstore via @endo/conversation-tree, and a single
// pinned factory caplet revives every session on daemon restart.

import { execFile } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';

import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import {
  makeConversationTree,
  makeEndoPetstoreBackend,
} from '@endo/conversation-tree';
import { runAgenticTurn } from '@endo/fae/src/turn-engine.js';
import {
  SubagentSpawnerInterface,
  assertSubagentName,
  isSameFormula,
  makeSubagentDelegations,
} from '@endo/fae/src/subagent.js';
import { DEFAULT_MAX_SUBAGENT_DEPTH } from '@endo/fae/src/subagent-host.js';
import { resolveAuthToken } from '@endo/fae/src/credentials.js';
import {
  assertHostedBackendDescriptor,
  normalizeHostedModelDescriptor,
} from '@endo/hosted-agent';

import { createStreamingProvider } from './providers/index.js';
import { runClaudeTurn } from './src/claude-turn.js';
import { runHostedTurn } from './src/hosted-turn.js';
import { makeSessionTurnSlot } from './src/session-turn-slot.js';
import { makeEndoToolSet, makeFlootToolRegistry } from './src/tool-registry.js';
import { makeContainerMountRegistrar } from './src/container-mounts.js';

// Cap the tool-call loop so a misbehaving model can't spin forever before it
// produces a spoken reply. A safety ceiling, not a work budget: a coding turn
// routinely takes dozens of tool rounds, and at 8 sessions bailed out mid-task
// with the tool-step fallback. `FLOOT_MAX_TOOL_ROUNDS` overrides it per
// deployment. The hosted backends run their own loops and never reach it.
const DEFAULT_MAX_TOOL_ROUNDS = 48;
const AGENT_SHUTDOWN_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);

const withTimeout = async (operation, label) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Error(`${label} timed out`)),
      AGENT_SHUTDOWN_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

// Initialize a fresh, empty directory as a git repository so a daemon git cap
// can be derived from it: provideGit requires an existing worktree, but a new
// scratch mount is just an empty dir. The exo git backend supplies its own
// author identity for the commits it makes; we only pin signing off here (so
// creation doesn't depend on a user-global commit.gpgSign) and seed an empty
// initial commit so the repo has a HEAD on the default branch.
const initGitRepo = async repoRoot => {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await execFileAsync('git', ['config', '--local', 'commit.gpgsign', 'false'], {
    cwd: repoRoot,
  });
  await execFileAsync('git', ['config', '--local', 'tag.gpgsign', 'false'], {
    cwd: repoRoot,
  });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.email=floot@endo',
      '-c',
      'user.name=Floot',
      'commit',
      '--allow-empty',
      '-m',
      'Initialize workspace',
    ],
    { cwd: repoRoot },
  );
};

/**
 * A writer (same shape as makeReplyChannel's) that buffers a turn's output
 * instead of streaming it, resolving `done` with the final text once the turn
 * ends. Used for inbox/mail turns, whose reply is sent as one buffered message
 * rather than streamed token-by-token.
 *
 * @returns {{ writer: object, done: Promise<{ ok: boolean, text?: string, error?: string }> }}
 */
const makeBufferingWriter = () => {
  let text = '';
  /** @type {(result: { ok: boolean, text?: string, error?: string }) => void} */
  let settle = () => {};
  const done = new Promise(resolve => {
    settle = resolve;
  });
  const writer = harden({
    setPhase: () => {},
    /** @param {string} t */
    delta: t => {
      text += t;
    },
    /** @param {string} t */
    final: t => {
      text = `${t}`;
    },
    toolCall: () => {},
    toolResult: () => {},
    usage: () => {},
    end: () => settle({ ok: true, text }),
    /** @param {unknown} reason */
    abort: reason => settle({ ok: false, error: `${reason}` }),
  });
  return { writer, done };
};

const FlootFactoryInterface = M.interface('FlootFactory', {
  createSession: M.callWhen()
    .optional(M.any(), M.string(), M.string())
    .returns(M.remotable()),
  listSessions: M.callWhen().returns(M.arrayOf(M.record())),
  listPresets: M.callWhen().returns(M.arrayOf(M.record())),
  listBackends: M.callWhen().returns(M.arrayOf(M.record())),
  listModels: M.callWhen().optional(M.string()).returns(M.arrayOf(M.record())),
  getSession: M.callWhen(M.string()).returns(M.remotable()),
  renameSession: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  deleteSession: M.callWhen(M.string()).returns(M.undefined()),
  refreshCredentials: M.callWhen().returns(M.undefined()),
  getAccount: M.callWhen().optional(M.boolean()).returns(M.record()),
  getAccountOracle: M.callWhen().returns(M.remotable()),
  help: M.call().optional(M.string()).returns(M.string()),
});

// The session facet handed to the UI. `startTurn` is synchronous (it hands back
// the turn immediately, before the turn runs), so it is guarded with `M.call`;
// the rest are async (`M.callWhen`). Guards are permissive — the daemon path is
// not runtime-tested here.
const FlootSessionInterface = M.interface('FlootSession', {
  getInfo: M.callWhen().returns(M.record()),
  startTurn: M.call(M.any()).returns(M.remotable()),
  getCurrentTurn: M.callWhen().returns(M.or(M.null(), M.record())),
  getHistory: M.callWhen().returns(M.any()),
  getUsage: M.callWhen().returns(M.any()),
  getAccount: M.callWhen().optional(M.boolean()).returns(M.record()),
  help: M.call().returns(M.string()),
});

const defaultSystemPrompt = `\
You are Floot, a warm, concise voice assistant living inside the Endo daemon.

Your replies are spoken aloud, so:
- Keep responses short and conversational — usually one to three sentences.
- Avoid markdown, code blocks, bullet lists, and emoji; write as you would speak.
- Answer directly. If you need to think, do it silently and give only the answer.

You live inside the Endo daemon as a guest with your own petstore — a private
namespace of named capabilities (objects you can call). You have tools to work
with it; use them silently, then speak only the result — never read code or raw
tool output aloud.

How the environment works: everything around you is an object capability. A
capability is a live remote object, not data — you act by CALLING its methods,
not by reading its fields. In exec, reach a capability through \`powers\` (your
guest interface) or by looking one up, and call methods with eventual-send:
\`const x = await E(ref).someMethod(args)\`. Always \`await\` and always go
through \`E(...)\` for capability calls.

When a tool result is itself a capability it shows as
\`[remote capability] callable methods: [...]\` listing the methods you can call
— that is a usable object, not an empty result. To work with it, look it up (or
store it) and call one of those methods via exec. Plain data (strings, numbers,
JSON) shows as its value.

Design and review:
- Discuss the design and acceptance criteria with the user before handoff.
- When the user asks to implement it, use handoffDesign with the complete agreed
  design, base revision, and review budget. The installed dev-review capability
  binds the developer, reviewers, project, and originating notification inbox.
- Use reviewStatus to inspect progress. A ready notification is a reviewed
  candidate; it is not permission to merge or deploy.

Petstore tools:
- list — see the petnames currently in your petstore.
- lookup — get a stored object by its petname so you can use it.
- store — save an object (or a result) under a petname for later.
- remove — forget a petname.
- exec — run JavaScript with your guest powers in scope as \`powers\`. This is
  your most general power: call any daemon capability, do math, transform data.
  Reach for it whenever no other tool fits.

Mail tools — other agents and people can send you messages, optionally with
objects attached:
- listMessages — read your inbox. Each message has a number, sender, text, and
  the edge names of any attached objects.
- adopt — take an attached object into your petstore by giving the message
  number and the object's edge name, plus a petname to file it under.
- send — send a message (and optionally objects) to another party.
- reply — respond to a message by its number.

Delegation — when spawnSubagent, askSubagent, and stopSubagent are listed among
your tools, you may hand a self-contained piece of work to a helper agent:
- spawnSubagent — create one, giving it standing instructions for its role.
- askSubagent — mail it a task and wait for its reply. It cannot see this
  conversation, so put everything it needs in the task.
- stopSubagent — release it once its work is done.
Use this for work whose details you don't need to keep — a long search, a
self-contained draft — not for things you can simply do yourself.

Caplet tools dropped into your \`tools/\` directory are discovered automatically,
so your abilities can grow over time. When asked what you can do, you can list
your tools and petnames to find out.
`;

// Flagship "vibe code a new project" persona: the base voice persona plus the
// framing that the session starts with a writable, git-backed workspace object
// already in its petstore (provisioned by the "new-project" preset).
export const newProjectSystemPrompt = `${defaultSystemPrompt}
You are starting a fresh project. Your petstore already contains a writable,
git-backed project workspace under the petname "workspace" — an EndoGit
capability. Use it via exec:
- \`const wt = await E(workspace).worktree()\` gives the working tree, a mount you
  can write to: \`E(wt).makeFile(path, text)\`, \`E(wt).writeText(path, text)\`,
  \`E(wt).remove(path)\`, \`E(wt).move(from, to)\`. A path argument is an array
  of segments — \`E(wt).writeText(['src', 'main.js'], text)\`; a bare string is
  a single name, and slash-joined strings are rejected. \`E(wt).entry('src/main.js')\`
  splits a slash path into a token any path argument accepts.
- \`E(workspace).status()\` returns \`{ entries, truncated }\`; each entry is
  copy data with \`path\`, \`index\`, and \`worktree\` fields, and \`truncated\`
  tells you whether the result was limited. \`E(workspace).diff()\` inspects
  changes.
- To stage one desired row: \`const result = await E(workspace).status(); const row = result.entries.find(({ path }) => path === "src/main.js"); if (!row) throw new Error("row not found"); await E(workspace).add([row.path])\`.
  Then \`E(workspace).commit(message)\` records them.
Build what the user asks for in the workspace, committing as you reach working
states. Speak short, plain summaries of what you did — never read code aloud.`;
harden(newProjectSystemPrompt);

// "Full control" persona: the base voice persona plus a reference to the daemon
// host itself ("endo") and the framing that this is dangerous, high-trust
// access that must be exercised carefully.
const fullControlSystemPrompt = `${defaultSystemPrompt}
You hold full control of this Endo daemon. Your petstore contains "endo" — a
reference to the daemon host itself, the most powerful capability there is.
Through it you can read, create, move, and destroy ANY capability in the daemon,
mint new agents, and run arbitrary code. Treat this access with great care:
- Move slowly and deliberately. Before anything destructive or irreversible —
  removing or cancelling a capability, overwriting a name, deleting an agent —
  say plainly what you are about to do and wait for the user to agree first.
- Prefer reading over writing. Inspect with list and lookup before you change
  anything; when unsure what a capability is, look before you act on it.
- Make the smallest change that satisfies the request. Don't tidy, reorganize,
  or "improve" the daemon's namespace unasked.
- Guard secrets. Never read API keys, tokens, or host filesystem paths aloud,
  and don't hand the "endo" reference (or anything derived from it) to another
  agent unless the user explicitly tells you to.

Operating the daemon — reach the host in exec with
\`const endo = await E(powers).lookup('endo')\`, then:
- \`E(endo).list()\` shows the names in the daemon's namespace; \`E(endo).lookup(name)\`
  retrieves one as a live capability.
- \`E(endo).makeDirectory(name)\` creates a sub-namespace; \`E(endo).move(['a'], ['b'])\`
  and \`E(endo).copy(['a'], ['b'])\` take path ARRAYS; \`E(endo).remove(name)\` drops a name.
- \`E(endo).evaluate(...)\` runs code in a worker — use it to build new caplets or
  one-off tools.
- \`E(endo).provideGuest(name)\` and \`E(endo).provideHost(name)\` mint new agents;
  \`E(endo).provideWorker(name)\` mints a worker.
- \`E(endo).cancel(name)\` tears a capability down — destructive, so confirm first.

Your petstore also contains "endo-src" — a READ-ONLY mount of the Endo
codebase you run inside. Use it to understand the capabilities you operate
before acting through "endo". In exec, look it up and read from it:
- \`const src = await E(powers).lookup('endo-src')\`
- \`E(src).list()\` lists the root; one segment per argument goes deeper:
  \`E(src).list('packages', 'daemon')\`.
- \`E(src).readText(path)\` reads a file. A path is an array of segments —
  \`E(src).readText(['packages', 'daemon', 'src', 'interfaces.js'])\` — never a
  slash-joined string. \`E(src).entry('packages/daemon/src/interfaces.js')\` is
  the one call that splits on "/"; its token works wherever a path does.
- It is strictly read-only — you cannot modify it. It may be absent if the
  daemon host does not have the source on disk; if a lookup fails, carry on
  without it.

A filesystem capability can also be MOUNTED AS A DISK in your sandbox, which
turns cap-by-cap file calls into ordinary file work. When your session runs in
a sandbox that supports it, your tools include three for this:
attachContainerMount, detachContainerMount, and listContainerMounts.
- \`attachContainerMount({ petName: 'endo-src', innerPath: '/mnt/endo-src' })\`
  binds a capability from YOUR petstore under \`/mnt/\`. A slash-separated path
  reaches through a capability you hold, so \`petName: 'endo/some-mount'\` finds
  \`some-mount\` in the daemon host's names.
- An EndoGit capability attaches its WORKTREE, so a checkout becomes a plain
  directory that in-sandbox \`git\` reads as a normal repository.
- The capability is the policy. Attaching "endo-src" gives you a READ-ONLY disk
  no matter which mode you ask for, because the cap itself is read-only —
  attach something writable when you intend to edit.
- Attaching RESTARTS the sandbox once the call returns, which aborts the turn
  in flight; your conversation and the sandbox's own files carry over, the
  rest of that turn does not. Check \`listContainerMounts()\` on the next turn
  instead of retrying blindly.
Speak short, plain summaries of what you did — never read code or raw capability
output aloud.`;

// "Machine admin" persona: full Endo control PLUS proposing changes to this
// host's NixOS configuration and to the Endo revision it runs. This is
// root-equivalent authority over the whole machine, so the prompt routes
// ordinary deploys through durable, operator-gated workflow runs and leaves
// the raw caplet for orientation and emergencies. Every recipe below is
// written against this tree's capability contracts — segment paths and
// `entry()` tokens on mounts, `sleep(ms)` in exec, run re-reach through the
// deploy connection — and test/machine-admin-workflows.test.js pins the parts
// a drift would silently break.
const machineAdminSystemPrompt = `${fullControlSystemPrompt}

You ALSO administer this machine's operating system. It runs NixOS. Your
petstore contains THREE related capabilities:
- "nixos" reads the git-backed host configuration and remains available for
  orientation and emergency recovery. Reach it with
  \`const nixos = await E(powers).lookup('nixos')\`. Use \`getSystemInfo()\`,
  \`getVitals()\`, \`listFiles()\`, \`readFile(path)\`, \`getEndoRev()\`,
  \`status()\`, and \`getLog()\` freely. Its raw stage/build/apply/rollback
  methods are ROOT-EQUIVALENT escape hatches: do NOT use them for an ordinary
  deployment, because doing so bypasses the durable journal and the owner's
  approval form.
- "deploy-endo" proposes a deployment of a pushed Endo revision through a
  pre-authorized workflow factory.
- "change-nixos" proposes a whole-file NixOS configuration change the same way.

NORMAL DEPLOYS MUST GO THROUGH A WORKFLOW FACTORY. A factory binds the
privileged performer and the owner who approves; you hold only authority to
propose a run and observe it. Starting a run stages and dry-builds the
proposal, then sends an approval form to the OWNER'S INBOX. Approval does NOT
happen in this conversation, and you cannot approve, cancel, or steer the run
yourself.

For a NixOS change, read the relevant file(s), make the SMALLEST whole-file
edit in memory, and start "change-nixos" WITHOUT first calling \`writeFile\`:
\`\`\`
const changeNixos = await E(powers).lookup('change-nixos');
const { runId } = await E(changeNixos).start({
  params: {
    title: 'commit-message-grade title',
    summary: 'what changes and why',
    files: [{ path: 'hosts/endo-tokyo.nix', text: completeNewText }],
  },
});
return {
  runId,
  status: await E(changeNixos).status(runId),
  waiting: await E(changeNixos).explain(runId),
};
\`\`\`
The chart stages the files, dry-builds, asks the owner, applies only after
approval, health-checks, auto-rolls-back on failure, and journals each step.
The raw "nixos" caplet remains for read access and emergencies; if a factory
is missing from your petstore, report that deployment is unavailable instead
of silently falling back to raw \`apply()\`.

You can also CHANGE THE ENDO SOURCE THIS MACHINE RUNS. The NixOS config pins
an exact Endo commit in "endo.rev", so the revision is part of the generation:
if a new revision leaves the daemon unhealthy, the workflow's apply
auto-rollback restores the previous revision with it.

The route from an edit to a running machine is: clone from the local Forgejo,
edit, commit, push a branch, then start a durable deploy workflow. The
workflow pins and applies only after its build and owner-inbox approval.
Never edit "endo-src" — it is the running code and is read-only on purpose.
Work in a scratch clone.

Push and clone happen HERE, through capabilities — not from a terminal.
Forgejo is a host service, so nothing but the daemon's own Git capabilities
can reach it.

Set up the work area ONCE — skip this if "endo-work" is already in the host's
names, because re-running mints a fresh scratch mount and rebinds the names,
orphaning the earlier work area and its commits:
\`\`\`
const endo = await E(powers).lookup('endo');
const credential = await E(endo).lookup('forgejo-credential');
// The forge's https origin is the credential's audience; this repository's
// mirror is floot/endo.git under it.
const url = \`\${await E(credential).audience()}/floot/endo.git\`;
if (!url.startsWith('https:')) {
  // Git remotes here speak https only; report this instead of proceeding.
  return \`The forge at \${url} is not served over https; nothing here can push to it.\`;
}
const identity = { authorName: 'Floot', authorEmail: 'floot@goooooo.ooo' };
const mount = await E(endo).provideScratchMount('endo-work-mount');
await E(endo).provideGitClone({
  destMount: mount,
  endpoint: { url, credential },
  identity,
});
const git = await E(endo).provideGit(mount, 'endo-work', { identity });
await E(endo).provideGitRemote(git, 'endo-work-origin', {
  name: 'origin', url, credential,
  allowedDirections: ['push'], allowedBranches: ['agent'],
});
return await E(git).currentBranch();
\`\`\`
Naming the mount, the git, and the remote is what lets later exec calls reach
them. The git carries the author identity you gave it, and the remote is
fenced to the \`agent\` branch, so what you commit and push is attributable
and reviewable.

Then MOUNT THE CHECKOUT AS A DISK and edit it as ordinary files. Prefer this to
editing through capability calls — it is the difference between one round trip
per file and simply working in a directory:
\`\`\`
attachContainerMount({ petName: 'endo/endo-work', innerPath: '/mnt/endo-work' })
\`\`\`
The worktree appears at \`/mnt/endo-work\`, and \`git\` in the sandbox inspects it
(status, diff, log) as the same repository the "endo-work" capability holds. The
attach restarts the sandbox and aborts this turn, so expect no result from the
call: begin the next turn with \`listContainerMounts()\` to confirm the bind, then
do the work.

Edit at \`/mnt/endo-work\` with your normal file tools, then stage and commit
THROUGH THE GIT capability — it carries the author identity from the clone,
which in-sandbox \`git commit\` does not:
\`\`\`
const endo = await E(powers).lookup('endo');
const git = await E(endo).lookup('endo-work');
const branches = await E(git).branches();
if (branches.some(b => b.name === 'agent')) await E(git).switchBranch('agent');
else await E(git).createBranch('agent', { switchAfterCreate: true });
const { entries } = await E(git).status();
await E(git).add(entries.map(e => e.path));
const commit = await E(git).commit('fix(floot): …');
return commit.oid;
\`\`\`
\`E(git).status()\` returns \`{ entries, truncated }\` (NOT an array); stage only
when it lists something.

For a one-line change, or when no disk is attached, edit through the MOUNT
capability instead and commit the same way:
\`\`\`
const endo = await E(powers).lookup('endo');
const mount = await E(endo).lookup('endo-work-mount');
const git = await E(endo).lookup('endo-work');
const file = 'packages/floot/agent.js';
const entry = await E(mount).entry(file);   // the one call that splits on "/"
const before = await E(mount).readText(entry);
await E(mount).writeText(entry, before.replace(oldText, newText));
await E(git).add([file]);
return (await E(git).commit('fix(floot): …')).oid;
\`\`\`
Mount paths are arrays of segments — \`E(mount).readText(['packages', 'floot',
'agent.js'])\` — or an \`entry()\` token; a slash-joined string is rejected.

Push, then PROPOSE the pushed revision through "deploy-endo". Do not call
\`stageRev\`, \`build\`, or \`apply\` yourself:
\`\`\`
const endo = await E(powers).lookup('endo');
const result = await E(await E(endo).lookup('endo-work-origin')).push({
  source: 'refs/heads/agent', destination: 'refs/heads/agent',
});
const head = await E(await E(endo).lookup('endo-work')).revParse('HEAD');
const deployEndo = await E(powers).lookup('deploy-endo');
const { runId } = await E(deployEndo).start({
  params: {
    title: 'commit-message-grade title',
    summary: 'what changed and why',
    rev: head.oid,
    branch: 'agent',
  },
});
return {
  pushed: result.updatedRefs,
  rev: head.oid,
  runId,
  status: await E(deployEndo).status(runId),
  waiting: await E(deployEndo).explain(runId),
};
\`\`\`
Tell the user the run id, what state it reached, and explicitly that its
approval form is in the owner's inbox, not this conversation. You never
receive the run itself, only its id; keep the id in the conversation. On a
later turn, re-reach
it through the same connection: \`E(deployEndo).status(runId)\`,
\`E(deployEndo).explain(runId)\`, and \`E(deployEndo).journal(runId, { from: 12n })\`
for the journal entries since a sequence number ("change-nixos" runs work the
same way through "change-nixos"). Checkpoint with \`status()\` so a turn never
blocks waiting for approval — \`await sleep(ms)\` between a few polls inside
one exec is fine; spinning is not. Narrate state CHANGES in short plain
language, especially for voice — never dump a journal or raw capability
output.

Rules that are not obvious and will bite you:
- PUSH BEFORE YOU START THE DEPLOY RUN. The host fetches a pinned revision from
  Forgejo and only finds commits reachable from a branch head. Proposing a
  commit you have not pushed makes the workflow's build fail to resolve it.
- Applying RESTARTS THE DAEMON. The work area and its commits survive.
  Credential material is process-local, so the start-up setup rotates the
  Forgejo credential in place and a remote holding it keeps working. A push
  that fails with "Git credential … has been revoked" means the credential
  the remote holds is dead: re-run the \`provideGitRemote\` call above once
  (the setup may have re-minted the credential under the same name), and if
  the push still fails that way the forge credential is not provisioned on
  this host — report that. One that fails with "GitRemote … has been revoked"
  means the remote itself was revoked: re-run \`provideGitRemote\`.
  \`E(remote).credentialHealth()\` reports \`available\` and \`revoked\` for a
  remote that still answers. Do not re-clone; only the remote needs redoing.
  A \`/mnt/\` disk survives too — attach records are replayed onto the rebuilt
  sandbox — so re-attaching is unnecessary; \`listContainerMounts()\` tells you.
- The remote pushes ONLY \`agent\` — a push to any other branch is refused by
  its policy. Stay on \`agent\` so the change is reviewable, and say what you
  pushed.
- A revision that only exists on Forgejo is fine to deploy here, but that is NOT
  an upstream proposal. Starting "deploy-endo" proposes a LOCAL deployment to
  the owner; it does not open a pull request. You have no route to GitHub —
  the forge credential is for the local forge only — so proposing upstream ends
  with you. Report the commit hash, branch, run id, and a one-line summary, and
  say plainly that the change is pending or running here but is not submitted
  upstream, so the user can take it from there.
- exec runs under SES lockdown: no \`Date.now()\`, no \`Math.random()\`, no
  \`setTimeout\`. \`sleep(ms)\` is provided for waiting between polls within one
  call; it is the only way to wait.
- exec results are JSON-serialized. BigInts render as decimal strings, so
  journal sequence numbers and \`stat()\` sizes arrive as text; pass a sequence
  back in as a BigInt literal (\`{ from: 12n }\`).
- \`git.log()\` entries carry \`summary\`, not \`message\`.
- Capability results have no size bound: one \`diff()\` or a wide \`list()\` can
  blow the turn. Narrow before you return, and filter at the source rather
  than reading everything back to sift it here.
Speak short, plain summaries — never read config text aloud.`;

// Catalog of session presets. Each preset pairs a system prompt with a set of
// objects to provision (idempotently) into the session guest's petstore the
// first time the session's agent is built. Provisioned objects are referenced
// ONLY by the session guest, so the daemon's GC reaps them (and their on-disk
// backing) when the session is deleted — there is no manual cleanup.
const PRESETS = [
  {
    id: 'general',
    title: 'General assistant',
    description: 'A blank session with no project workspace.',
    systemPrompt: defaultSystemPrompt,
    objects: [],
  },
  {
    id: 'new-project',
    title: 'New project',
    description:
      'Start a project with a writable, git-backed workspace ready to populate.',
    systemPrompt: newProjectSystemPrompt,
    objects: [{ kind: 'git-workspace', petName: 'workspace' }],
  },
  {
    id: 'full-control',
    title: 'Full Endo control',
    description:
      'Full control of the Endo daemon via an "endo" host reference. High access — handle with care.',
    systemPrompt: fullControlSystemPrompt,
    objects: [
      { kind: 'host-powers', petName: 'endo' },
      { kind: 'code-mount', petName: 'endo-src', required: false },
    ],
  },
  {
    id: 'machine-admin',
    // Unlike ordinary persona edits, deploy-authority changes must reach
    // existing admin sessions: an older prompt would keep driving the raw
    // root-equivalent caplet, or name recipes this tree does not implement.
    // Bump only for a deliberate, reviewed migration; refreshPresetEntry
    // snapshots the new text into each matching registry entry exactly once.
    // v1 was the first workflow-routed prompt, on the deployment this preset
    // was ported from; v2 is this tree's re-derivation (segment paths and
    // `entry()` tokens, `sleep(ms)` in exec, run re-reach through the deploy
    // connection rather than the workflow service).
    promptVersion: 2,
    title: 'Machine admin (NixOS)',
    description:
      "Full Endo control PLUS proposing this host's NixOS configuration changes and Endo releases through operator-approved deploy workflows. Root-equivalent machine control — handle with extreme care.",
    systemPrompt: machineAdminSystemPrompt,
    objects: [
      { kind: 'host-powers', petName: 'endo' },
      { kind: 'code-mount', petName: 'endo-src', required: false },
      // The raw caplet: the session is not a machine admin without it.
      { kind: 'nixos-admin', petName: 'nixos', grantName: 'nixos-admin' },
      // The deploy connections: optional, so the session still opens on a
      // host without the workflow service — its prompt then reports that
      // deployment is unavailable rather than falling back to the caplet.
      {
        kind: 'workflow-factory',
        petName: 'deploy-endo',
        grantName: 'deploy-endo-factory',
        required: false,
      },
      {
        kind: 'workflow-factory',
        petName: 'change-nixos',
        grantName: 'change-nixos-factory',
        required: false,
      },
    ],
  },
];
const DEFAULT_PRESET_ID = 'general';
export const getPreset = id =>
  PRESETS.find(p => p.id === id) ||
  /** @type {(typeof PRESETS)[number]} */ (
    PRESETS.find(p => p.id === DEFAULT_PRESET_ID)
  );
harden(getPreset);

/**
 * Apply an explicitly versioned preset-prompt migration to one session
 * registry entry. Ordinary preset text remains snapshotted forever; only a
 * preset carrying a newer `promptVersion` opts into changing live sessions,
 * and only sessions that run the preset's own prompt: a session whose
 * operator supplied a custom prompt keeps it, and a delegated session keeps
 * the composition its parent wrote (the parent's part is not stored on its
 * own, so it could not be recomposed).
 *
 * @param {{ presetId?: string, systemPrompt?: string, presetPromptVersion?: number, parentSessionId?: string, customPrompt?: boolean } & Record<string, any>} entry
 * @returns {typeof entry}
 */
export const refreshPresetEntry = entry => {
  const preset = getPreset(entry.presetId || DEFAULT_PRESET_ID);
  const promptVersion =
    'promptVersion' in preset ? preset.promptVersion : undefined;
  if (
    promptVersion === undefined ||
    (entry.presetPromptVersion || 0) >= promptVersion ||
    entry.parentSessionId !== undefined ||
    entry.customPrompt === true
  ) {
    return entry;
  }
  return harden({
    ...entry,
    systemPrompt: preset.systemPrompt,
    presetPromptVersion: promptVersion,
  });
};
harden(refreshPresetEntry);

// Catalog of models selectable for a new session. A session that does not pin
// one of these follows the factory's configured default model (the `model` in
// the `llm-provider` config, or the provider's own fallback). Ids are passed
// verbatim to the provider, so they must be valid for the configured backend —
// these are the Anthropic ids used by the default provider.
const MODELS = [
  {
    id: 'claude-opus-4-8',
    title: 'Claude Opus 4.8',
    description: 'Most capable — best for hard reasoning and agentic work.',
  },
  {
    id: 'claude-sonnet-4-6',
    title: 'Claude Sonnet 4.6',
    description: 'Balanced speed and capability — a good default.',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    title: 'Claude Haiku 4.5',
    description: 'Fastest and cheapest — best for quick, simple turns.',
  },
];
// Recognize persisted legacy sessions so revival refuses them explicitly.
const CLAUDE_CLI_MODEL_ID = 'claude-cli';
// Mirrors createStreamingProvider's fallback so the UI's notion of "default"
// agrees with what an unpinned session actually runs.
const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';
const isKnownModel = id => MODELS.some(m => m.id === id);
const hostedModelId = (backendId, modelId) => `${backendId}:${modelId}`;

/**
 * Provision a preset's objects into a session guest's petstore, referenced ONLY
 * by the guest so deleting the session collects them (and their on-disk backing)
 * automatically. Idempotent: an object whose petname already exists is left
 * untouched, so this is safe to call on every revival.
 *
 * @param {any} host - the factory's own host powers
 * @param {string} agentName - petname (in the host) of the session's guest agent
 * @param {any} sessionGuest - the resolved guest facet (for `has` checks)
 * @param {string} id - session id (used to namespace temporary host petnames)
 * @param {Array<{ kind: string, petName: string, required?: boolean, grantName?: string }>} objects
 * @param {string} [codePath] - absolute host path to the Endo codebase, for the
 *   `code-mount` object kind (read-only). Absent when the daemon host has no
 *   source on disk; such objects are then skipped.
 */
const provisionPresetObjects = async (
  host,
  agentName,
  sessionGuest,
  id,
  objects,
  codePath,
) => {
  for (const obj of objects) {
    const alreadyPresent = await E(sessionGuest).has(obj.petName);
    if (obj.kind === 'nixos-admin' || obj.kind === 'workflow-factory') {
      // Copy a grant the setup script stored on this factory host
      // (machine-admin-setup.js) into the guest's petstore: the NixOS
      // machine-admin caplet, or a deploy-workflow connection — a
      // formula-backed, proposal-only facade over one factory
      // (deploy-connection.js), whose `start` returns a run id and whose
      // observation is scoped to that factory's runs. Unlike the other
      // kinds this one is re-copied on every revival: `copy` overwrites, and
      // the setup re-creates the connection caplet each boot, so a revived
      // session follows the grant's current identity. The grant is absent
      // (or retracted) on a daemon without the NixOS controller or the
      // workflow service: a copy the session already holds is kept, a
      // required object with no copy fails session creation loudly, and an
      // optional one is skipped so the session opens without that authority.
      const grantName = obj.grantName || obj.petName;
      if (await E(host).has(grantName)) {
        await E(host).copy([grantName], [agentName, obj.petName]);
      } else if (alreadyPresent) {
        // Keep the copy: its provider may return, and dropping it would
        // silently narrow a session that already opened with it.
      } else if (obj.required !== false) {
        throw Error(
          `Required preset object "${obj.petName}" needs grant "${grantName}", which this factory host does not hold`,
        );
      } else {
        console.warn(
          `[floot-factory] optional grant "${grantName}" is unavailable; skipping "${obj.petName}" for session ${id}`,
        );
      }
    } else if (alreadyPresent) {
      // Idempotent: a revived session already has its provisioned objects.
    } else if (obj.kind === 'git-workspace') {
      // Mint a daemon-managed scratch mount, derive a git cap over it, then move
      // the git cap into the guest's petstore and drop the host-side scratch
      // petname. The git formula keeps the mount alive by reference (daemon GC:
      // git depends on its mount), so the only petstore reference left is the
      // guest's — deleting the session reaps the whole chain (and the scratch
      // dir on disk). Temporary host petnames are namespaced by session id and
      // cleared first in case a prior attempt aborted mid-way.
      const scratchTmp = `_floot-scratch-${id}`;
      const gitTmp = `_floot-git-${id}`;
      for (const tmp of [gitTmp, scratchTmp]) {
        if (await E(host).has(tmp)) await E(host).remove(tmp);
      }
      const mount = await E(host).provideScratchMount(scratchTmp);
      // provideGit requires an existing worktree, but a fresh scratch mount is
      // an empty dir — git-init it first. The factory is an unconfined,
      // fully-privileged host caplet, so resolving the host path and running
      // git here is in-bounds; that path never reaches the session guest or the
      // UI (they only ever receive the derived git cap, not its filesystem
      // location).
      const repoRoot = await E(host).provideHostPath(mount);
      await initGitRepo(repoRoot);
      await E(host).provideGit(mount, gitTmp);
      await E(host).move([gitTmp], [agentName, obj.petName]);
      await E(host).remove(scratchTmp);
    } else if (obj.kind === 'host-powers') {
      // Copy the factory's own host agent (@agent — the full host powers, not
      // the weaker @self handle) into the guest's petstore, granting the
      // session full daemon control. The host outlives every session, so this
      // only adds a name in the guest; deleting the session drops that name and
      // reaps nothing else.
      await E(host).copy(['@agent'], [agentName, obj.petName]);
    } else if (obj.kind === 'code-mount') {
      // Mount the Endo codebase read-only so the session can read the source it
      // runs inside. Skip silently when no path was configured (the daemon host
      // may not have the source on disk). The mount points at an EXISTING
      // external directory — unlike a scratch mount it does not own that dir, so
      // GC of the formula when the session is deleted never touches the source.
      // Provide into a session-scoped temp host name (cleared first in case a
      // prior attempt aborted), then move it into the guest's petstore so the
      // guest is the only reference.
      if (!codePath) {
        if (obj.required !== false) {
          throw Error(
            `No code path is configured for required preset object "${obj.petName}"`,
          );
        }
        console.warn(
          `[floot-factory] optional code mount "${obj.petName}" is unavailable for session ${id}`,
        );
      } else {
        const mountTmp = `_floot-codemount-${id}`;
        if (await E(host).has(mountTmp)) await E(host).remove(mountTmp);
        await E(host).provideMount(codePath, mountTmp, { readOnly: true });
        await E(host).move([mountTmp], [agentName, obj.petName]);
      }
    } else {
      throw Error(`Unknown required preset object kind "${obj.kind}"`);
    }
  }
};

/**
 * @typedef {object} ProviderConstructorConfig
 * @property {string} host
 * @property {string} model
 * @property {string} authToken
 */

/**
 * @typedef {object} InjectedProviderConfig
 * @property {{ chatStream: (messages: any[], tools: any[], onDelta: (delta: string) => void, signal?: AbortSignal) => Promise<any> }} provider
 */

/**
 * @typedef {object} LateProviderConfig
 * @property {() => Promise<any>} provideProvider - Resolved once per turn
 *   rather than held, so dropping a cached provider (`refreshCredentials`)
 *   reaches a session that is already open.
 */

/**
 * @typedef {object} ClaudeClientConfig
 * @property {any} claudeClient - A ClaudeClient capability
 *   (@endo/claude-sandbox): `send(prompt) -> reply reader` of raw stream-json
 *   events. Turns bypass the provider tool loop — the CLI runs its own tools
 *   in the sandbox and keeps its own conversation continuity.
 */

/**
 * Build a streaming agent over a guest's powers. The returned object exposes
 * `converse(input, writer)`, which appends to the conversation tree, streams the
 * model's reply through `writer` (src/stream.js), and persists the assistant
 * turn so subsequent calls keep context.
 *
 * The user message (`input`) is streamable too: it may be a plain string, or a
 * Far reader yielding transcript-style events (the same wire the audio caplet's
 * `transcribe` emits — `{type:'partial'|'final', text}` with replace semantics,
 * terminated by `end`/`abort`). Either way the message is fully assembled before
 * the LLM call, since Anthropic/Claude need a complete user turn — but the
 * interface accepts the stream now so callers (and a future streaming backend)
 * need not change. This lets the voice Space pipe transcribe()'s reader straight
 * into converse().
 *
 * Unlike fae's `spawnWorkerLoop`, this does NOT follow the inbox; it is driven
 * by direct method calls (the caller owns the loop), which is what lets the
 * reply stream straight back to that caller over CapTP.
 *
 * @param {any} powers - Guest powers (petstore for conversation history)
 * @param {Promise<object> | object | undefined} _context
 * @param {ProviderConstructorConfig | InjectedProviderConfig | LateProviderConfig | ClaudeClientConfig | { hostedClient: any } | { provideHostedClient: (snapshot: any) => Promise<any> }} providerConfig
 * @param {string} [systemPrompt]
 * @param {object} [options]
 * @param {any} [options.spawner] - A `SubagentSpawner` capability. Absent for a
 *   session at the delegation bound, which withholds the subagent tools.
 * @param {any} [options.accountOracle] - A read-only `HostedAccount`. Absent
 *   when the deployment has provisioned no oracle, which withholds
 *   `accountStatus`.
 * @param {string} [options.modelId] - The model this session runs, used to
 *   price its usage.
 * @param {number} [options.maxToolRounds] - Provider calls one turn may make
 *   before the tool-step fallback. Defaults to `DEFAULT_MAX_TOOL_ROUNDS`.
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [options.timers]
 * @param {Map<string, any>} [options.extraTools] - Session-specific tools
 *   the factory built (see `makeFlootToolRegistry`).
 * @returns {Promise<{
 *   converse: (
 *     input: string | object,
 *     writer: object,
 *     meta?: object,
 *     signal?: AbortSignal,
 *     onStart?: (history: Array<Record<string, any>>) => void,
 *   ) => Promise<void>,
 *   getHistory: () => Promise<Array<Record<string, any>>>,
 *   getUsage: () => Promise<{ inputTokens: number, outputTokens: number, turns: number }>,
 *   startInbox: () => void,
 *   shutdown: (allowBackendQuarantine?: boolean) => Promise<void>,
 * }>}
 */
export const makeStreamingAgent = async (
  powers,
  _context,
  providerConfig,
  systemPrompt,
  {
    spawner,
    accountOracle,
    modelId,
    timers,
    maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
    extraTools,
  } = {},
) => {
  const claudeClient = /** @type {any} */ (providerConfig).claudeClient;
  let hostedClient = /** @type {any} */ (providerConfig).hostedClient;
  const provideHostedClient = /** @type {any} */ (providerConfig)
    .provideHostedClient;
  const provideProvider = /** @type {any} */ (providerConfig).provideProvider;
  /** @type {any} */
  const staticProvider =
    claudeClient || hostedClient || provideHostedClient || provideProvider
      ? null
      : /** @type {any} */ (providerConfig).provider ||
        createStreamingProvider({
          LAL_HOST: /** @type {any} */ (providerConfig).host,
          LAL_MODEL: /** @type {any} */ (providerConfig).model,
          LAL_AUTH_TOKEN: /** @type {any} */ (providerConfig).authToken,
        });

  /**
   * The provider this turn runs on.
   *
   * Resolved per turn rather than captured at construction: a provider pins the
   * auth token as of the moment it was built, so a session holding one would go
   * on using a rotated — or revoked — credential until the daemon restarted.
   * `refreshCredentials()` drops the factory's cache, and the next turn asks
   * for it again.
   */
  const currentProvider = async () =>
    provideProvider ? provideProvider() : staticProvider;

  const effectivePrompt = systemPrompt || defaultSystemPrompt;
  const tree = makeConversationTree(makeEndoPetstoreBackend(powers));

  // Cumulative token usage for this session, persisted to the guest petstore so
  // it survives a daemon restart. Loaded lazily; updated after each turn.
  const USAGE_NAME = 'floot-usage';
  /** @type {{ inputTokens: number, outputTokens: number, turns: number } | undefined} */
  let usage;
  const findRecordedUsage = async () => {
    let nodeId = await getOrCreateLeaf();
    while (nodeId) {
      const node = await tree.getNode(nodeId);
      if (!node) break;
      const recorded = /** @type {any} */ (node.metadata?.usageTotals);
      if (recorded) {
        return {
          inputTokens: Number(recorded.inputTokens) || 0,
          outputTokens: Number(recorded.outputTokens) || 0,
          turns: Number(recorded.turns) || 0,
        };
      }
      nodeId = node.parentId;
    }
    return undefined;
  };
  const loadUsage = async () => {
    if (usage) return usage;
    const recorded = await findRecordedUsage();
    if (recorded) {
      usage = recorded;
    } else if (await E(powers).has(USAGE_NAME)) {
      const stored = /** @type {any} */ (await E(powers).lookup(USAGE_NAME));
      usage = {
        inputTokens: Number(stored?.inputTokens) || 0,
        outputTokens: Number(stored?.outputTokens) || 0,
        turns: Number(stored?.turns) || 0,
      };
    } else {
      usage = { inputTokens: 0, outputTokens: 0, turns: 0 };
    }
    return usage;
  };
  // Serialize writes to the legacy summary cache. The authoritative totals are
  // also committed in conversation-node metadata, so a crash or cache write
  // failure can be recovered by walking back from the durable leaf.
  let usageWrite = Promise.resolve();
  const saveUsage = () => {
    const snapshot = harden({ ...usage });
    usageWrite = usageWrite
      .then(async () => {
        await null;
        if (await E(powers).has(USAGE_NAME)) await E(powers).remove(USAGE_NAME);
        await E(powers).storeValue(snapshot, USAGE_NAME);
      })
      .catch(error => {
        console.error(
          '[floot] could not persist usage:',
          error instanceof Error ? error.message : String(error),
        );
      });
    return usageWrite;
  };

  // Delegation state is per session and lives beside the inbox loop that feeds
  // it: `claim` below is the only reader of the mailbox stream.
  const delegations = makeSubagentDelegations(
    harden({ powers, ...(timers ? { timers } : {}) }),
  );
  const settledMail = new Set();
  const toolRegistry = makeFlootToolRegistry(powers, {
    settledMail,
    ...(extraTools ? { extraTools } : {}),
    ...(spawner ? { spawner, delegations } : {}),
    ...(accountOracle
      ? {
          accountOracle,
          // The oracle prices what this session actually spent, so the tool
          // reads the same totals the UI shows rather than a second tally.
          getUsage: () => getUsage(),
          getModelId: () => modelId || '',
        }
      : {}),
  });

  // One session = one guest = one linear conversation. The guest's petstore
  // holds a conversation-tree root and a linear branch beneath it. We cache the
  // current leaf in memory and rediscover it from the tree on first use after a
  // restart. The match is NOT keyed on the system prompt: that orphaned all
  // history whenever the prompt changed. Instead we reuse the root with the
  // deepest branch — the one that actually holds the conversation — ignoring any
  // empty roots a past prompt change may have spawned. The current prompt is
  // applied at call time (see runTurn), so reusing an old root never leaks a
  // stale prompt.
  /** @type {string | undefined} */
  let cachedLeaf;

  const getOrCreateLeaf = async () => {
    if (cachedLeaf !== undefined) return cachedLeaf;

    const roots = await tree.getRoots();
    /** @type {{ leaf: string, depth: number } | undefined} */
    let best;
    for (const r of roots) {
      // Walk down the (linear) branch to its deepest node, counting depth.
      let leaf = r.id;
      let depth = 0;
      for (;;) {
        const kids = await tree.getChildren(leaf);
        if (!kids || kids.length === 0) break;
        leaf = kids[kids.length - 1].id;
        depth += 1;
      }
      if (best === undefined || depth > best.depth) {
        best = { leaf, depth };
      }
    }
    if (best !== undefined) {
      cachedLeaf = best.leaf;
      return best.leaf;
    }

    const root = await tree.addNode(null, [
      { role: 'system', content: effectivePrompt },
    ]);
    cachedLeaf = root.id;
    return root.id;
  };

  // Serialize turns: a streaming reply must finish (and persist its assistant
  // node) before the next converse() reads the path, or context would race.
  let turnChain = Promise.resolve();
  let stopped = false;
  let quarantineError;
  const turnControllers = new Set();

  // Assemble the user message. A string is used as-is; a reader is drained
  // (replace semantics — each partial/final carries the full text so far) until
  // it ends, so the complete turn is ready before the (non-streaming) LLM call.
  const resolveUserText = async input => {
    if (typeof input === 'string') return input;
    let text = '';
    for await (const value of iterateReader(input, { buffer: 4 })) {
      if (value?.type === 'end') break;
      if (value?.type === 'partial' || value?.type === 'final') {
        text = `${value.text}`;
      } else if (value?.type === 'abort') {
        throw new Error(value.reason || 'user message aborted');
      }
    }
    return text;
  };

  const runTurn = async (input, writer, meta, signal) => {
    const text = await resolveUserText(input);
    let baseLeafId = await getOrCreateLeaf();
    const baseNode = await tree.getNode(baseLeafId);
    const acknowledgedCheckpoint =
      typeof baseNode?.metadata?.backendCheckpoint === 'string'
        ? baseNode.metadata.backendCheckpoint
        : undefined;
    const receivedMail = meta?.mail?.messageNumber !== undefined;
    const inputMessages = [
      { role: 'user', content: `${text}`, ...(meta ? { meta } : {}) },
    ];
    if (receivedMail) {
      // Receiving typed mail is durable independently of the model's answer.
      // In particular, a readiness acknowledgement tool must never run before
      // the notice is visible in history. Deduplicate a replay after a failed
      // provider call or a crash before the mailbox dismissal.
      const path = await tree.getPath(baseLeafId);
      if (
        !path.some(
          message =>
            message.meta?.mail?.messageNumber === meta.mail.messageNumber,
        )
      ) {
        const received = await tree.addNode(baseLeafId, inputMessages, {
          ...(acknowledgedCheckpoint
            ? { backendCheckpoint: acknowledgedCheckpoint }
            : {}),
        });
        baseLeafId = received.id;
        cachedLeaf = received.id;
      }
    }

    const commitExternalTurn = async (
      replyText,
      turnUsage,
      backendCheckpoint,
      toolCalls = [],
    ) => {
      const current = await loadUsage();
      const nextUsage = {
        inputTokens: current.inputTokens + (turnUsage?.inputTokens || 0),
        outputTokens: current.outputTokens + (turnUsage?.outputTokens || 0),
        turns: current.turns + 1,
      };
      const messages = receivedMail ? [] : [...inputMessages];
      if (toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.args },
          })),
        });
        messages.push(
          ...toolCalls.map(call => ({
            role: 'tool',
            tool_call_id: call.id,
            content: call.result ?? '',
          })),
        );
      }
      messages.push({ role: 'assistant', content: replyText });
      // Commit the external answer and accounting as a unit. Typed incoming
      // mail was recorded separately; ordinary input remains atomic with its
      // answer, so a failed runtime call cannot leave an orphaned UI turn.
      const finalNode = await tree.addNode(baseLeafId, messages, {
        usageTotals: harden({ ...nextUsage }),
        ...(backendCheckpoint ? { backendCheckpoint } : {}),
      });
      cachedLeaf = finalNode.id;
      usage = nextUsage;
      await saveUsage();
      if (backendCheckpoint && hostedClient) {
        try {
          await E(hostedClient).acknowledge(backendCheckpoint);
        } catch (error) {
          // The durable tree node is the source of truth. The checkpoint rides
          // on the next send and safely completes acknowledgement after a
          // transient failure or reincarnation.
          console.error(
            `[floot] backend checkpoint acknowledgement deferred: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      writer.usage(nextUsage);
      writer.final(replyText);
      writer.end();
    };

    if (claudeClient) {
      // Claude-CLI turn: one send to the ClaudeClient capability. The CLI runs
      // its own agentic loop in the sandbox (tools, continuity via the
      // workspace), so the provider tool loop below is bypassed; the persisted
      // history keeps only the user turn and the final assistant text.
      writer.setPhase('thinking');
      const { finalContent: replyText, usage: turnUsage } = await runClaudeTurn(
        { client: claudeClient, text, writer, signal },
      );
      if (signal?.aborted) return;
      await commitExternalTurn(replyText, turnUsage);
      return;
    }

    if (hostedClient) {
      writer.setPhase('thinking');
      const {
        finalContent: replyText,
        usage: turnUsage,
        toolCalls,
        checkpoint,
      } = await runHostedTurn({
        client: hostedClient,
        text,
        writer,
        signal,
        systemPrompt: effectivePrompt,
        acknowledgedCheckpoint,
      });
      if (signal?.aborted) return;
      await commitExternalTurn(replyText, turnUsage, checkpoint, toolCalls);
      return;
    }

    // `meta` rides along on the user node (the provider ignores unknown fields)
    // so getHistory can mark, e.g., turns that arrived via mail rather than the
    // local UI.
    const stagedMessages = receivedMail ? [] : [...inputMessages];

    // Agentic loop: stream a reply; if it calls tools, run them, persist the
    // assistant turn plus tool results, and loop again until the model returns a
    // plain (spoken) answer. Tools are re-discovered each round so anything the
    // model creates mid-turn (e.g. via exec/store) is immediately callable.
    let finalContent = '';
    // Whether the model produced a plain (toolless) answer. If it never does
    // within maxToolRounds, we send a fallback instead of an empty reply.
    let answered = false;
    // Token usage accumulates across this turn's rounds (each tool round is its
    // own provider call).
    let turnInput = 0;
    let turnOutput = 0;
    writer.setPhase('thinking');

    const loop = await runAgenticTurn({
      leafId: baseLeafId,
      maxRounds: maxToolRounds,
      getTools: async () => {
        if (signal?.aborted) throw Error('Floot turn aborted');
        return toolRegistry.snapshot();
      },
      getContext: async () => {
        const path = await tree.getPath(baseLeafId);
        return [
          { role: 'system', content: effectivePrompt },
          ...path.filter(message => message.role !== 'system'),
          ...stagedMessages,
        ];
      },
      invoke: async (context, tools, round) => {
        console.error(
          `[floot] round ${round}: ${context.length} messages, ${tools.providerSchemas.length} tools`,
        );
        let streamed = '';
        const provider = await currentProvider();
        const { message, usage: roundUsage } = await provider.chatStream(
          context,
          tools.providerSchemas,
          delta => {
            streamed += delta;
            writer.delta(delta);
          },
          signal,
        );
        if (roundUsage) {
          turnInput += roundUsage.inputTokens || 0;
          turnOutput += roundUsage.outputTokens || 0;
        }
        return harden({
          message: message || { role: 'assistant', content: streamed },
        });
      },
      getToolCalls: message =>
        Array.isArray(message.tool_calls) ? message.tool_calls : [],
      runTools: async (calls, tools, round) => {
        writer.setPhase('using tools');
        const normalizedCalls = calls.map((call, index) => ({
          ...call,
          id: call.id || `floot-synth-${round}-${index}`,
        }));
        const runOne = async call => {
          const name = call.function?.name;
          let args = {};
          let parseError;
          try {
            args =
              typeof call.function?.arguments === 'string'
                ? JSON.parse(call.function.arguments || '{}')
                : call.function?.arguments || {};
          } catch (error) {
            parseError = error instanceof Error ? error.message : String(error);
          }
          writer.toolCall({
            id: call.id,
            name: `${name}`,
            args: JSON.stringify(args),
          });
          let resultText;
          if (parseError !== undefined) {
            resultText = `Error: could not parse tool arguments as JSON (${parseError}). Re-send this tool call with valid JSON arguments.`;
          } else {
            try {
              resultText = await tools.execute(name, args);
            } catch (error) {
              resultText = `Error: ${
                error instanceof Error ? error.message : String(error)
              }`;
            }
          }
          writer.toolResult({
            id: call.id,
            name: `${name}`,
            result: `${resultText}`,
          });
          console.error(
            `[floot] tool ${name} -> ${`${resultText}`.length} chars`,
          );
          return {
            role: 'tool',
            tool_call_id: call.id,
            content: `${resultText}`,
          };
        };
        const results = await Promise.all(normalizedCalls.map(runOne));
        return harden({ normalizedCalls, results });
      },
      commitStep: async (currentLeafId, message, step) => {
        stagedMessages.push(
          { ...message, tool_calls: step.normalizedCalls },
          ...step.results,
        );
        writer.setPhase('thinking');
        return currentLeafId;
      },
      commitFinal: async (currentLeafId, message) => {
        finalContent = message.content || '';
        stagedMessages.push(message);
        return currentLeafId;
      },
    });
    answered = loop.answered;

    if (!answered) {
      // The loop hit maxToolRounds while the model still wanted to call tools,
      // so it never produced a spoken answer. Persist and speak a fallback so the
      // turn ends on a well-formed assistant message instead of an empty reply
      // sitting atop a dangling tool_result.
      finalContent =
        "I wasn't able to finish that within my tool-step limit. Could you narrow it down or try again?";
      stagedMessages.push({ role: 'assistant', content: finalContent });
      console.error(
        `[floot] turn hit maxToolRounds (${maxToolRounds}); sent fallback reply`,
      );
    }

    // Fold this turn's token usage into the session total, persist it, and emit
    // it so the UI can surface per-session cost.
    // Compute the next totals without touching the cache, then adopt them only
    // once the node carrying them is durable — the same discipline as
    // `commitExternalTurn`. Mutating the live cache first meant a failed
    // `addNode` left the in-memory counters permanently inflated by a turn
    // that produced nothing, and the next successful turn committed that
    // inflated figure as authoritative metadata.
    const current = await loadUsage();
    const totals = harden({
      inputTokens: current.inputTokens + turnInput,
      outputTokens: current.outputTokens + turnOutput,
      turns: current.turns + 1,
    });
    // Persist the complete answer and accounting in one node. A provider
    // failure leaves no partially answered branch for revival to adopt.
    const committedNode = await tree.addNode(baseLeafId, stagedMessages, {
      usageTotals: totals,
    });
    cachedLeaf = committedNode.id;
    usage = { ...totals };
    await saveUsage();
    writer.usage(totals);
    writer.final(finalContent);
    writer.end();
  };

  /**
   * Close the inbox loop.
   *
   * Quarantine and shutdown both mean this agent will never take another turn,
   * but the loop is parked in `messages.next()` and would otherwise keep
   * accepting mail: for every message it would call `converse`, drop an
   * unobserved rejection, and mail the quarantine error back to the sender —
   * indefinitely, and with no way to stop it short of a daemon restart.
   * Declared before `converse` so its quarantine path can reach it; the
   * iterator it closes is bound later, which is why this is a function.
   */
  const stopInbox = () => {
    signalInboxStopped();

    wakeMailWorker();

    if (inboxIterator) {
      void Promise.resolve(inboxIterator.return()).catch(() => undefined);
    }
  };

  const converse = (input, writer, meta, signal, onStart) => {
    if (stopped || quarantineError) {
      const error =
        quarantineError || Error('Floot session agent is shutting down');
      writer.abort(error.message);
      return Promise.reject(error);
    }
    const turnController = new AbortController();
    turnControllers.add(turnController);
    const forwardAbort = () => turnController.abort();
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const result = turnChain.then(async () => {
      // Capture recovery history within the execution chain, after earlier mail.
      if (onStart) onStart(await getHistory());
      return stopped
        ? Promise.reject(Error('Floot session agent is shutting down'))
        : runTurn(input, writer, meta, turnController.signal).catch(err => {
            // A cancelled turn (`FlootTurn.cancel`, or shutdown) aborts
            // `signal`, tearing down the in-flight provider stream. That's a
            // clean stop, not a failure, and the turn's owner has already
            // closed the reply channel, so swallow it.
            if (turnController.signal.aborted) {
              if (
                err?.name === 'HostedTurnCancellationError' ||
                `${err?.message || ''}`.includes(
                  'Hosted turn cancellation failed:',
                )
              ) {
                quarantineError = err;
                stopped = true;
                stopInbox();
                writer.abort(err.message);
                throw err;
              }
              if (stopped) writer.abort('Floot session agent shut down');
              return;
            }
            // runTurn has no internal catch, so on failure the writer is still
            // unsettled — abort it here or every consumer (UI stream and the mail
            // inbox's turnDone) would hang forever. Rethrow so callers still see it.
            writer.abort(err instanceof Error ? err.message : String(err));
            throw err;
          });
    });
    const releaseTurn = () => {
      signal?.removeEventListener('abort', forwardAbort);
      turnControllers.delete(turnController);
      if (stopped) writer.abort('Floot session agent shut down');
    };
    result.then(releaseTurn, releaseTurn);
    // Keep the chain alive even if a turn rejects.
    turnChain = result.catch(() => {});
    return result;
  };

  // Inbox loop: a session is also addressable by mail. We follow the guest's
  // inbox and feed each incoming message through the SAME turn machinery as
  // converse() (so mail and UI turns share one conversation thread and are
  // serialized by turnChain), then send the reply back as one buffered mail
  // message via reply(). Streaming-over-mail is a later phase; for now the
  // reply is the assembled final text.
  let inboxStarted = false;
  let inboxIterator;
  let inboxLoop = Promise.resolve();
  /**
   * Settles when this agent stops, so the pump can leave without waiting for
   * the mailbox to say something.
   *
   * `inboxIterator.return()` is not enough: the reader pump awaits a
   * synchronization node only *between* pulls, so once it is parked in the
   * source's `next()` on a quiet mailbox it never observes the close, and the
   * cancel hangs with it. Racing the read against this is what lets a session
   * with nothing in its inbox shut down promptly instead of timing out.
   */
  let signalInboxStopped = () => {};
  const inboxStopped = new Promise(resolve => {
    signalInboxStopped = resolve;
  });
  /** Wakes the mail worker; rebound when a pump starts. */
  let wakeMailWorker = () => {};
  const startInbox = () => {
    if (inboxStarted || stopped) return;
    inboxStarted = true;
    inboxLoop = (async () => {
      const selfLocator = await E(powers).locate('@self');
      const messages = iterateReader(E(powers).followMessages());
      inboxIterator = messages;
      if (stopped) {
        await messages.return();
        return;
      }
      // followMessages can deliver the same message twice: its initial drain
      // iterates a *live* Map that our own reply() mutates (so the iterator
      // re-yields the freshly-added reply), and that reply is also republished
      // to the topic the drain later consumes. Process each number once, or the
      // second dismiss() of an already-removed message throws and kills the loop.
      const handled = new Set();
      // A mail turn is run by the worker below rather than awaited in the loop.
      //
      // `askSubagent` blocks inside a turn until `delegations.claim` observes
      // the subagent's reply, and the only reader that feeds `claim` is this
      // loop. Awaiting the turn here therefore waits on a message the loop can
      // no longer read: every ask from a mail-triggered turn times out.
      //
      // The queue is deliberately unbounded. What it holds is a reference to a
      // message the daemon is holding anyway, and it drains monotonically.
      // Declining past a bound would be worse: `followMessages` first drains
      // the whole live mailbox, far faster than the model answers, so a
      // backlog — a restart with unread mail, say — would be refused wholesale
      // even though the session goes idle moments later.
      /** @type {Array<{ number: any, text: string, fromName: any }>} */
      const pendingMail = [];
      /** @type {(() => void) | undefined} */
      let parkedWorker;
      let pumpEnded = false;
      const wakeMail = () => {
        const notify = parkedWorker;
        parkedWorker = undefined;
        if (notify) notify();
      };
      // Reachable from `stopInbox`, so a shutdown releases a parked worker
      // rather than depending on the pump to notice.
      wakeMailWorker = wakeMail;

      /**
       * Dismissal is bookkeeping, and `followMessages` can re-deliver a number
       * whose message this loop already removed. Letting that throw would kill
       * the pump — and with it delegation for the rest of the session.
       *
       * @param {any} messageNumber
       */
      const dismissQuietly = async messageNumber =>
        E(powers)
          .dismiss(messageNumber)
          .catch(error => {
            console.error(
              `[floot] could not dismiss message #${messageNumber}:`,
              error instanceof Error ? error.message : String(error),
            );
          });

      const mailWorker = (async () => {
        for (;;) {
          if (pendingMail.length === 0) {
            if (pumpEnded || stopped) return;

            await new Promise(resolve => {
              parkedWorker = resolve;
            });
            // eslint-disable-next-line no-continue
            continue;
          }
          const { number, text, fromName, type } = /** @type {any} */ (
            pendingMail.shift()
          );
          try {
            if (stopped || quarantineError) return;
            const { writer, done: turnDone } = makeBufferingWriter();
            // Route through converse so the turn joins turnChain and shares
            // context. Tag the turn as mail so getHistory can mark it (and the
            // UI can show the sender) rather than render it like local input.
            // The turn's outcome is read from the writer, so the promise itself
            // is deliberately unused — but it must still be observed, or a turn
            // that rejects before reaching the writer becomes an unhandled
            // rejection in the daemon worker.
            const turnP = converse(text, writer, {
              mail: {
                from: fromName,
                ...(type === 'request' || type === 'form'
                  ? { messageNumber: String(number) }
                  : {}),
              },
            }).then(
              () => undefined,
              error =>
                harden({ ok: false, error: `${error?.message || error}` }),
            );
            // Raced, not simply awaited: `runTurn` has early exits that return
            // *successfully* without settling the writer, and only
            // `releaseTurn`'s shutdown-time abort rescues them. A turn
            // controller aborted for any other reason would park this worker
            // on `turnDone` for good, so the second racer has to be a terminal
            // value rather than a hand-off back to `turnDone`. On every normal
            // path `writer.end()` runs before the turn resolves, so `turnDone`
            // wins and this never fires.

            const result = await Promise.race([
              turnDone,
              turnP.then(
                outcome =>
                  outcome ||
                  harden({
                    ok: false,
                    error: 'turn ended without settling its reply',
                  }),
              ),
            ]);
            // A turn that finished is answered and dismissed whatever else is
            // happening: its history is committed and the model was paid for.
            // Only a turn shutdown aborted is left in the inbox, for the next
            // incarnation. Typed incoming mail is already recorded, and its
            // message number deduplicates the receipt on replay.
            if (!result.ok && stopped) return;
            const replyText = result.ok
              ? result.text || ''
              : `Error: ${result.error}`;

            if (type === 'request' || type === 'form') {
              if (
                !settledMail.delete(String(number)) &&
                !(await E(powers).has(`workflow-settled-${number}`))
              ) {
                // A provider failure is not a typed rejection. Preserve the
                // request for recovery; its incoming text is already durable.
                // Preserve unanswered forms for recovery or the operator too.
                // eslint-disable-next-line no-continue
                if (!result.ok || type === 'form') continue;
                await E(powers).reject(
                  number,
                  'Agent ended the turn without a typed answer',
                );
              }
            } else {
              await E(powers).reply(number, [replyText], [], []);
            }
            // Dismiss after handling so the message leaves the inbox and is not
            // reprocessed when followMessages replays on the next daemon
            // restart. Bookkeeping, like the pump's: a failure here must not
            // be reported as "could not complete mail turn", which the turn
            // plainly did.

            await dismissQuietly(number);
          } catch (error) {
            console.error(
              `[floot] could not complete mail turn #${number}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      })();
      // Raced against the stop signal on every pull: the reader pump observes a
      // close only *between* pulls, so a session whose mailbox has gone quiet
      // cannot be cancelled through the iterator alone. Derived once — inside
      // the loop it would append a reaction per message to a promise that stays
      // pending for the session's whole life.
      const whenStopped = inboxStopped.then(() =>
        harden({ value: undefined, done: true }),
      );
      // The tail below runs however this loop leaves — normally, by shutdown,
      // or by a throw. Without it, a pump that died left the worker parked on a
      // wake that would never come, holding every message it had already read.
      try {
        for (;;) {
          const next = await Promise.race([messages.next(), whenStopped]);
          const { value: message, done } = next;
          if (done) break;
          const {
            from: fromId,
            number,
            type,
            strings,
            names,
            done: messageDone = true,
          } = message;
          if (handled.has(number)) {
            // eslint-disable-next-line no-continue
            continue;
          }
          // A sender may reveal a message progressively and settle it later with
          // `editMessage`; the daemon re-emits the settled revision under the
          // same number. Marking the partial handled would swallow that revision
          // — including a subagent's reply, which `claim` deliberately refuses
          // while it is still partial — and would answer a half-written message.
          if (messageDone === false) {
            // eslint-disable-next-line no-continue
            continue;
          }
          handled.add(number);
          // Offer every message — this session's own outbound mail included —
          // to the delegation registry first. It learns a delegation's identity
          // from the echo of the send and consumes the matching reply, which
          // the awaiting `askSubagent` call returns instead of this loop
          // turning it into a conversation (and replying to it, which with a
          // subagent would be an unbounded exchange).
          if (delegations.claim(message).claimed) {
            // Dismissed like every other message this loop handles. Leaving it
            // would mean that after a restart — when no ask is pending — the
            // reply replays as an ordinary message, this session answers it,
            // and the subagent answers back: two models in an unbounded
            // exchange. The cost is that a reply's attachments are not
            // retained, which `askSubagent` says plainly.
            await dismissQuietly(number);
            // eslint-disable-next-line no-continue
            continue;
          }
          // Skip our own outbound messages echoed back into the inbox.
          // Compare formulas, not locator strings: `locate` decorates with the
          // transport hints currently published by `@nets` while a message's
          // `from` is always hint-free, so a daemon with network addresses
          // would fail string equality and answer its own mail.
          if (isSameFormula(fromId, selfLocator)) {
            await dismissQuietly(number);
            // eslint-disable-next-line no-continue
            continue;
          }

          let text;
          if (type === 'package' && Array.isArray(strings)) {
            const parts = [];
            const namesArray = Array.isArray(names) ? names : [];
            for (let i = 0; i < strings.length; i += 1) {
              parts.push(strings[i]);
              if (i < namesArray.length) parts.push(`@${namesArray[i]}`);
            }
            text = parts.join('').trim();
            // This message is dismissed once this turn ends, so any attached
            // object must be adopted now. Tell the model the message number
            // and edge names so it can call adopt within this same turn.
            if (namesArray.length) {
              const edges = namesArray.map(n => `"${n}"`).join(', ');
              text += `\n\n(System: message #${number} attaches object(s) with edge name(s) ${edges}. To keep any of them, call the adopt tool with message number ${number} and the edge name during this turn — the message is dismissed afterward.)`;
            }
          } else if (type === 'request' || type === 'form') {
            text = `[Inbox ${type} #${number}] ${message.description}\n\n${
              type === 'request'
                ? `Answer with resolveRequest(messageNumber: "${number}", value: ...), or rejectRequest. A prose reply does not answer this request.`
                : `Answer with submitForm(messageNumber: "${number}", values: ...). Fields: ${message.fields.map(field => field.name).join(', ')}.`
            }`;
          } else {
            text = `(${type || 'unknown'} message)`;
          }

          // Resolve a friendly sender name for the history entry: the
          // petname(s) this guest has for the sender, falling back to the
          // locator. The reply is sent to the same sender by message number.
          let fromName;
          try {
            const senderNames = await E(powers).reverseLocate(fromId);
            fromName =
              Array.isArray(senderNames) && senderNames.length
                ? senderNames[0]
                : fromId;
          } catch {
            fromName = fromId;
          }

          if (stopped || quarantineError) break;
          pendingMail.push({ number, text, fromName, type });
          wakeMail();
        }
      } finally {
        // Nothing can feed `claim` once this loop is out — and nothing restarts
        // it — so an ask that kept waiting would hold the queue open for its
        // whole timeout, five minutes by default, for a reply that can no
        // longer arrive. The reason names the cause, because a session whose
        // pump died of something transient goes on answering the UI while
        // delegation is permanently gone, and an opaque error there would
        // connect to nothing in the log.
        pumpEnded = true;
        delegations.close(
          Error(
            'Floot session inbox loop ended; delegation is unavailable until the session is recreated',
          ),
        );
        wakeMail();
      }
      // Let queued replies finish before the loop resolves, so a shutdown that
      // awaits `inboxLoop` waits for mail this session already answered.
      await mailWorker;
    })().catch(error => {
      if (stopped) return;
      // Deliberately not resetting `inboxStarted`: nothing calls `startInbox`
      // twice, and a second pump would race a permanently-resolved
      // `inboxStopped` and a closed delegation registry. The session keeps
      // serving the UI; what it has lost is mail and delegation, which is what
      // this says.
      console.error(
        '[floot] inbox loop ended in error; this session no longer receives mail or delegates:',
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  const shutdownAgent = async (allowBackendQuarantine = false) => {
    stopped = true;
    for (const controller of turnControllers) controller.abort();
    // Release the pump and any parked worker before awaiting either. The
    // iterator's own `return()` cannot do it: the reader pump observes a close
    // only between pulls, so a session whose mailbox is quiet would otherwise
    // sit here until the shutdown timeout.
    // `stopInbox` already asked the iterator to close and fired the stop
    // signal the pump races against. Its `return()` is deliberately *not*
    // awaited here: the reader pump observes a close only between pulls, so on
    // a quiet mailbox that promise never settles and would hold this shutdown
    // to its timeout even though the loop it guards has already left.
    stopInbox();
    const closing = [turnChain, inboxLoop];
    const settled = await withTimeout(
      Promise.allSettled(closing),
      'Floot session agent shutdown',
    );
    const failures = /** @type {PromiseRejectedResult[]} */ (settled)
      .filter(result => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Floot session agent shutdown failed');
    }
    if (quarantineError && !allowBackendQuarantine) throw quarantineError;
  };

  // Replay the conversation for UI repaint: user prompts, the assistant's spoken
  // answers, and each tool call paired with its result so tool activity survives
  // a refresh. The system prompt (root) is omitted.
  const getHistory = async () => {
    const leafId = await getOrCreateLeaf();
    const path = await tree.getPath(leafId);
    const out = [];
    // Call IDs are provider-local and may repeat in later turns. Pair each raw
    // tool result with the earliest unmatched call of that ID as the linear
    // path is replayed, rather than globally indexing by ID and overwriting an
    // earlier turn's result.
    const pendingById = new Map();
    for (const m of path) {
      if (m.role === 'tool' && m.tool_call_id != null) {
        const pending = pendingById.get(m.tool_call_id);
        const index = pending?.shift();
        if (index !== undefined) out[index].result = m.content;
        // eslint-disable-next-line no-continue
        continue;
      }
      if (m.role !== 'user' && m.role !== 'assistant') {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (typeof m.content === 'string' && m.content.trim() !== '') {
        out.push({
          role: m.role,
          content: m.content,
          ...(m.meta ? { meta: m.meta } : {}),
        });
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const args = tc.function?.arguments;
          const index = out.length;
          out.push({
            role: 'tool',
            name: tc.function?.name || 'tool',
            args: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
            result: null,
          });
          const pending = pendingById.get(tc.id) || [];
          pending.push(index);
          pendingById.set(tc.id, pending);
        }
      }
    }
    return harden(out);
  };

  const getUsage = async () => harden({ ...(await loadUsage()) });

  if (provideHostedClient) {
    // Provision from the same capability-gated catalog as the provider loop,
    // after delegation and account tools have been installed.
    hostedClient = await provideHostedClient(await toolRegistry.snapshot());
  }

  return harden({
    converse,
    getHistory,
    getUsage,
    startInbox,
    shutdown: shutdownAgent,
  });
};
harden(makeStreamingAgent);

// ============================================================================
// Floot Factory — entry point (mirrors fae's factory recipe)
// ============================================================================

// Petname (in the factory guest's own petstore) where the session registry —
// an array of { id, title, createdAt } — is persisted.
const REGISTRY_NAME = 'floot-sessions';
// Legacy write-ahead snapshot: authoritative until migrated into the journal.
const REGISTRY_BACKUP_NAME = 'floot-sessions-backup';
const REGISTRY_PREFIX = 'floot-sessions-v1-';
/**
 * Snapshots retained behind the newest. One is enough for correctness — the
 * newest complete snapshot is the record — and a handful gives an operator
 * something to fall back on if the newest turns out to be unreadable.
 */
const REGISTRY_JOURNAL_DEPTH = 4;

const newSessionId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The Floot factory — a single long-lived, pinned caplet that owns every chat
 * session. The UI references ONLY this factory; it never sees a guest.
 *
 * Each session is, internally, its own EndoGuest (isolated petstore for
 * conversation history, tool endowments, and — later — an inbox). That a session
 * "is a guest" is an implementation detail hidden behind opaque session facets
 * (Far objects with `startTurn(input) -> FlootTurn` and `getHistory()`). The
 * factory operates each session guest's petstore directly via an in-process
 * `makeStreamingAgent`, so there is exactly one pin (the factory) rather than a
 * pin per session.
 *
 * Persistence is daemon-only: the session registry lives in the factory's own
 * petstore (REGISTRY_NAME), and each session's history lives in its guest's
 * petstore. On restart the daemon revives the pinned factory; sessions are
 * revived lazily (provideGuest is idempotent) on first use.
 *
 * IMPORTANT (reincarnation constraint, same as the fae/driver caplets): make()
 * must return synchronously WITHOUT awaiting remote references on its powers
 * host, or it deadlocks with the provision chain creating this very formula.
 * So the provider, registry, and per-session guests are all resolved lazily.
 *
 * @param {import('@endo/eventual-send').FarRef<object>} hostPowers
 * @param {Promise<object> | object | undefined} _context
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {object}
 */
/**
 * The system prompt a new session runs under.
 *
 * A caller of the public `createSession` speaks with the operator's own
 * authority, so a prompt it supplies replaces the preset's.
 *
 * A *delegated* session's prompt is composed instead. The parent model writes
 * the child's instructions, while the preset still decides which objects the
 * child gets — so substituting would let a model spawn a session with its own
 * tools and none of the operator's standing instructions. That is a way around
 * them, not a way to delegate.
 *
 * @param {object} options
 * @param {string} options.presetPrompt
 * @param {string} [options.requestedPrompt]
 * @param {boolean} [options.delegated]
 * @returns {string}
 */
export const composeSessionSystemPrompt = ({
  presetPrompt,
  requestedPrompt,
  delegated = false,
}) => {
  if (!requestedPrompt) return presetPrompt;
  if (!delegated) return `${requestedPrompt}`;
  return [
    presetPrompt,
    '---',
    'You are a subagent. Your parent agent gave you these standing ' +
      'instructions, which do not replace anything above:',
    `${requestedPrompt}`,
  ].join('\n\n');
};
harden(composeSessionSystemPrompt);

export const make = (hostPowers, _context, { env } = {}) => {
  /** @type {any} */
  const powers = hostPowers;
  const systemPrompt = env?.FLOOT_SYSTEM_PROMPT || undefined;
  // Absolute host path to the Endo codebase, mounted read-only into full-control
  // sessions (see the `code-mount` preset object). Resolved by the setup script
  // and passed through env; empty when the daemon host has no source on disk.
  const codePath = env?.FLOOT_CODE_PATH || undefined;

  // The factory runs with its own host powers, so it provisions session guests
  // directly — no introduced `host-agent` reference (that rehydrates as a
  // mail-only Handle after a restart, leaving provideGuest/locate unavailable on
  // revived sessions). `powers` here is the factory's own host.
  const getHost = () => powers;

  // The provider config (backend kind, default model, auth token) lives behind
  // the `llm-provider` capability handle. Resolve it once and cache it; every
  // per-model provider is built from it.
  let providerConfigP;
  const getProviderConfig = () => {
    if (!providerConfigP) {
      providerConfigP = E(powers)
        .lookup('llm-provider')
        .catch(error => {
          providerConfigP = undefined;
          throw error;
        });
    }
    return providerConfigP;
  };

  // Legacy credential-in-slice Claude clients are deliberately not admitted.
  // A verified Claude implementation must use the hosted factory boundary.
  // Sessions receive only the turn protocol: send, interrupt, and acknowledge.
  // Factory-owned termination and resource administration stay outside the agent.
  const makeSendOnlyClient = client =>
    harden({
      send: (prompt, opts) => E(client).send(prompt, opts),
      interrupt: () => E(client).interrupt(),
      acknowledge: checkpoint => E(client).acknowledge(checkpoint),
    });

  // Runtime container-mount attach registrar
  // (designs/runtime-container-fs-mount.md): validates guest-chosen /mnt/
  // paths, proves cap possession against the session guest's own petstore,
  // persists ref-counted attach records in this factory's petstore, and drives
  // the sandbox client's bind set. The privileged 9P bridging runs in a
  // separate provider holding the fs-mounter and root-host authority
  // (@endo/claude-sandbox's container-mount-bridge.js, or a session
  // provisioner that mixed its two methods in); a deployment with no such
  // provider simply leaves attach unavailable, with a clear error.
  const containerMountRegistrar = makeContainerMountRegistrar({
    powers,
    getBridgeProvider: async () => {
      const providerName =
        env?.FLOOT_CONTAINER_MOUNT_BRIDGE || 'container-mount-bridge';
      if (!(await E(powers).has(providerName))) return undefined;
      const provider = await E(powers).lookup(providerName);
      try {
        // Introspect rather than duck-type: a failed CapTP call per method
        // is noise, and a provider without the pair cannot bridge anyway.
        // eslint-disable-next-line no-underscore-dangle
        const methods = await E(provider).__getMethodNames__();
        if (methods.includes('provideContainerMountBridge')) {
          return provider;
        }
      } catch {
        // A provider without introspection cannot be checked, so it is not
        // one this registrar knows how to drive.
      }
      return undefined;
    },
  });

  // Hosted backend factories are operator-endowed capabilities. Discovery is
  // explicit and bounded to configured petnames plus the conventional Codex
  // name; the session/model never receives a factory or lifecycle admin facet.
  const configuredBackendNames = [
    ...(env?.FLOOT_BACKEND_FACTORIES || '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
    'codex-backend',
    'claude-backend',
  ];
  /** @type {Promise<Map<string, { factory: any, descriptor: any }>> | undefined} */
  let hostedBackendsP;
  const getHostedBackends = () => {
    if (!hostedBackendsP) {
      hostedBackendsP = (async () => {
        const backends = new Map();
        for (const name of [...new Set(configuredBackendNames)]) {
          // eslint-disable-next-line @jessie.js/safe-await-separator
          if (await E(powers).has(name)) {
            const factory = await E(powers).lookup(name);

            const descriptor = assertHostedBackendDescriptor(
              await E(factory).describe(),
            );
            if (backends.has(descriptor.id)) {
              throw Error(`Invalid or duplicate hosted backend at "${name}"`);
            }
            backends.set(descriptor.id, { factory, descriptor });
          }
        }
        return backends;
      })().catch(error => {
        hostedBackendsP = undefined;
        throw error;
      });
    }
    return hostedBackendsP;
  };

  // The account oracle is an operator-endowed, read-only capability: it answers
  // what plan this deployment is on and how much quota is left, and it cannot
  // reach the credential it describes. Absent by default — a deployment that
  // has provisioned none simply has no `accountStatus` tool and a factory whose
  // `getAccount()` reports that nothing is available.
  const accountOracleName = env?.FLOOT_ACCOUNT_ORACLE || 'account-oracle';
  /** @type {Promise<any> | undefined} */
  let accountOracleP;
  const getAccountOracle = () => {
    if (!accountOracleP) {
      accountOracleP = (async () => {
        if (!(await E(powers).has(accountOracleName))) {
          // Do not cache the absence. An oracle is provisioned by re-running
          // setup, which binds the name without restarting this caplet, and a
          // remembered `undefined` would withhold `accountStatus` from every
          // session for the life of the daemon.
          accountOracleP = undefined;
          return undefined;
        }
        return E(powers).lookup(accountOracleName);
      })().catch(error => {
        accountOracleP = undefined;
        throw error;
      });
    }
    return accountOracleP;
  };

  /**
   * The model id a session's usage is priced against.
   *
   * An unpinned session — the default — records no model and follows the
   * factory's configured one, so asking `entry.model` alone yields `''` and
   * nothing can be priced. Both the `accountStatus` tool and the session
   * facet's `getAccount` must answer the same way, or a user gets a cost from
   * the model and a blank from the UI panel beside it.
   *
   * @param {any} entry
   * @returns {Promise<string>}
   */
  const sessionModelId = async entry => {
    if (entry?.backendId) {
      return hostedModelId(entry.backendId, entry.modelId || '');
    }
    if (entry?.model) return `${entry.model}`;
    try {
      return `${(await getProviderConfig()).model || ''}`;
    } catch {
      // Pricing is a nicety; a session that cannot read its provider config has
      // a larger problem, and it will surface on its next turn.
      return '';
    }
  };

  /** @type {Map<string, any>} */
  const backendAdmins = new Map();
  // Per session, the adapter that lets the container-mount registrar drive
  // a hosted backend session's declared attaches
  // (designs/runtime-container-fs-mount.md). Kept so deletion can wait for
  // a recreate that is still in flight.
  /** @type {Map<string, { close: () => Promise<void> }>} */
  const hostedMountClients = new Map();

  // A hosted backend refuses to stop under an unsettled Endo tool call — and
  // the attach that asks for a recreate IS one until its result is back —
  // so a recreate waits for the call to settle rather than deadlocking on it.
  const HOSTED_RECREATE_SETTLE_INTERVAL_MS = 50;
  const HOSTED_RECREATE_SETTLE_ATTEMPTS = 200;

  /**
   * The registrar's view of a hosted backend session: a client whose bind
   * set is the `containerMounts` its next `create` declares. The attested
   * runtime cannot change a live slice's mount table — the table is what it
   * attests — so a changed set terminates the backend session and creates it
   * again with the new declaration. The durable workspace, the Codex state
   * volume and the thread survive that; the turn in flight does not, which
   * the design accepts (attach is disruptive by design).
   *
   * The recreate is scheduled, never awaited by `setExtraMounts`: the
   * registrar calls it from inside the attach tool, and the backend will not
   * stop while that tool call is unsettled. A recreate the sandbox refuses —
   * its attestation would not prove an attach — drops this session's binds
   * (their records and bridges included) so no record claims a bind the
   * container lacks, recreates without them, and reports why on the next
   * turn.
   *
   * @param {object} options
   * @param {string} options.id
   * @param {any} options.backend
   * @param {Record<string, any>} options.spec
   * @param {() => any} options.getToolSet
   * @param {() => Promise<void>} options.dropOwnBinds
   */
  const makeHostedMountClient = ({
    id,
    backend,
    spec,
    getToolSet,
    dropOwnBinds,
  }) => {
    /** @type {readonly { key: string, source: string, destination: string, mode: 'ro' | 'rw' }[]} */
    let declared = harden([]);
    /** @type {{ run: any, admin: any } | undefined} */
    let live;
    /** The declaration the live backend session was created with. */
    let liveDeclared = declared;
    // Before `start`, a changed declaration is simply what the first create
    // declares; after `close`, nothing is recreated any more.
    let started = false;
    let closed = false;
    /** @type {Promise<void>} */
    let chain = Promise.resolve();
    // While the failure path is shedding binds, their detaches must only
    // update the declaration; the one recreate at the end applies it.
    let shedding = false;
    /** @type {Error | undefined} */
    let pendingReport;

    const createLive = async () => {
      const declaring = declared;
      const session = await E(backend.factory).create(
        harden({
          ...spec,
          ...(declaring.length > 0 ? { containerMounts: declaring } : {}),
        }),
        getToolSet(),
      );
      live = session;
      liveDeclared = declaring;
      backendAdmins.set(id, session.admin);
    };
    const liveIsCurrent = () =>
      live !== undefined &&
      JSON.stringify(liveDeclared) === JSON.stringify(declared);
    const terminateLive = async () => {
      if (!live) return;
      const { admin } = live;
      for (let attempt = 0; ; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await E(admin).terminate();
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : `${error}`;
          if (
            !/unsettled Endo tool call/.test(message) ||
            attempt >= HOSTED_RECREATE_SETTLE_ATTEMPTS
          ) {
            throw error;
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => {
            setTimeout(resolve, HOSTED_RECREATE_SETTLE_INTERVAL_MS);
          });
        }
      }
      live = undefined;
    };
    const recreate = async () => {
      // Idempotent, so scheduling one per declaration change is safe: a
      // declaration that changed while a create was in flight is applied by
      // the next entry on the chain, and one the live session already
      // declares costs no restart.
      if (closed || liveIsCurrent()) return;
      await terminateLive();
      try {
        await createLive();
      } catch (error) {
        const dropped = declared.map(attach => attach.destination);
        console.error(
          `[floot-factory] the sandbox for session ${id} could not be recreated with ${dropped.join(', ')}; dropping the bind(s):`,
          error instanceof Error ? error.message : String(error),
        );
        shedding = true;
        try {
          await dropOwnBinds();
        } finally {
          shedding = false;
        }
        declared = harden([]);
        pendingReport = Error(
          `The sandbox could not be recreated with ${dropped.join(', ')} and the bind(s) were dropped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await createLive();
      }
    };
    /**
     * Queue `step` behind everything scheduled so far. The returned promise
     * carries the step's own failure; the chain itself never rejects.
     *
     * @param {() => Promise<void>} step
     */
    const enqueue = step => {
      const run = chain.then(step);
      chain = run.catch(() => {});
      return run;
    };
    const requireLive = () => {
      if (pendingReport) {
        const report = pendingReport;
        pendingReport = undefined;
        throw report;
      }
      if (!live) {
        throw Error(`Session ${id} has no running sandbox`);
      }
      return live.run;
    };
    return harden({
      /**
       * First creation, after the registrar has replayed its records. On
       * the chain, so a declaration that changes during it is applied after.
       */
      start: () => {
        started = true;
        return enqueue(createLive);
      },
      /**
       * Let a recreate in flight finish and schedule no more: the session is
       * being torn down, and a successor created underneath that would leak.
       */
      close: async () => {
        closed = true;
        await chain;
      },
      /** @param {readonly any[]} extras */
      async setExtraMounts(extras) {
        declared = harden(
          extras.map(extra => ({
            key: extra.key,
            source: extra.mountPoint,
            destination: extra.innerPath,
            mode: extra.mode,
          })),
        );
        if (!started || shedding || closed) return;
        enqueue(recreate).catch(error => {
          console.error(
            `[floot-factory] container-mount recreate failed for session ${id}:`,
            error instanceof Error ? error.message : String(error),
          );
        });
      },
      run: harden({
        send: async (prompt, opts) => {
          // A turn sent during a recreate waits for the successor rather
          // than failing. A (re)creation that failed, or a restart the
          // backend refused for the whole settle budget, is retried here —
          // by the turn, whose own failure it then is — rather than logged
          // once and left inconsistent with the recorded binds.
          await chain;
          if (started && !closed && !liveIsCurrent()) {
            await enqueue(recreate);
          }
          return E(requireLive()).send(prompt, opts);
        },
        // A session being recreated has no turn left to interrupt and no
        // checkpoint left to acknowledge: the terminate ended them.
        interrupt: () => (live ? E(live.run).interrupt() : undefined),
        acknowledge: checkpoint =>
          live ? E(live.run).acknowledge(checkpoint) : undefined,
      }),
    });
  };

  // One streaming provider per model. Sessions that don't pin a model share the
  // entry under the empty-string key (the factory's configured default model).
  //
  // The auth token is read from the `SecretBlob`, never held in the config
  // value, and re-read for every turn: a provider pins the token it was built
  // with, so a cache keyed on the model alone would go on presenting a revoked
  // credential until somebody thought to call `refreshCredentials()`. Keyed on
  // the bytes as well, a rotation or revocation takes effect by itself on the
  // next turn, and an unrotated deployment still reuses the provider it built.
  /** @type {Map<string, { token: string, providerP: Promise<any> }>} */
  const providersByModel = new Map();
  const getProvider = async model => {
    const key = model || '';
    const cfg = await getProviderConfig();
    // A revoked secret rejects here, which fails the turn rather than letting
    // a cached provider answer it.
    const token = await resolveAuthToken({ powers, config: cfg });
    const cached = providersByModel.get(key);
    if (cached && cached.token === token) return cached.providerP;
    const providerP = (async () =>
      createStreamingProvider({
        FLOOT_PROVIDER: cfg.provider,
        FLOOT_MODEL: model || cfg.model,
        FLOOT_AUTH_TOKEN: token,
      }))().catch(error => {
      if (providersByModel.get(key)?.token === token) {
        providersByModel.delete(key);
      }
      throw error;
    });
    providersByModel.set(key, { token, providerP });
    return providerP;
  };

  // In-memory session registry, mirrored to the factory's petstore. Loaded
  // lazily so make() never awaits.
  /** @type {Array<{ id: string, title: string, createdAt: number, presetId?: string, systemPrompt?: string, presetPromptVersion?: number, customPrompt?: boolean, model?: string, backendId?: string, modelId?: string, reasoningEffort?: string, lifecycle?: string }> | undefined} */
  let registry;
  let registryLoadP;
  let registrySequence = 0n;
  const retireRegistryBackup = async () => {
    try {
      if (await E(powers).has(REGISTRY_BACKUP_NAME)) {
        await E(powers).remove(REGISTRY_BACKUP_NAME);
      }
    } catch (error) {
      // The journal is already durable. Keep the obsolete backup rooted and
      // retry on the next load/save without rolling back the committed record.
      console.error('[floot-factory] registry backup cleanup failed:', error);
    }
  };
  const loadRegistry = () => {
    if (registry) return Promise.resolve(registry);
    if (!registryLoadP) {
      registryLoadP = (async () => {
        const names = await E(powers).list();
        const journalNames = (Array.isArray(names) ? names : [])
          .filter(
            name =>
              typeof name === 'string' &&
              name.startsWith(REGISTRY_PREFIX) &&
              /^[0-9]{20}$/.test(name.slice(REGISTRY_PREFIX.length)),
          )
          .sort();
        if (journalNames.length > 0) {
          const latestName = journalNames.at(-1);
          const stored = await E(powers).lookup(latestName);
          if (
            stored?.version !== 1 ||
            !Array.isArray(stored.sessions) ||
            typeof stored.sequence !== 'bigint' ||
            latestName !==
              `${REGISTRY_PREFIX}${`${stored.sequence}`.padStart(20, '0')}`
          ) {
            throw Error('Floot lifecycle registry journal is corrupt');
          }
          await retireRegistryBackup();
          registry = [...stored.sessions];
          registrySequence = stored.sequence + 1n;
        } else if (await E(powers).has(REGISTRY_BACKUP_NAME)) {
          const stored = await E(powers).lookup(REGISTRY_BACKUP_NAME);
          if (!Array.isArray(stored)) {
            throw Error('Floot legacy registry backup is corrupt');
          }
          // An interrupted legacy replacement may have no canonical name,
          // or a stale one. Publish its backup to a fresh journal name before
          // releasing that recovery root or exposing the registry in memory.
          await E(powers).storeValue(
            harden({ version: 1, sequence: 0n, sessions: stored }),
            `${REGISTRY_PREFIX}${'0'.repeat(20)}`,
          );
          await retireRegistryBackup();
          registry = [...stored];
          registrySequence = 1n;
        } else if (await E(powers).has(REGISTRY_NAME)) {
          const stored = await E(powers).lookup(REGISTRY_NAME);
          registry = Array.isArray(stored) ? [...stored] : [];
        } else {
          registry = [];
        }
        // A versioned preset-prompt migration (refreshPresetEntry) lands
        // here, before any session agent is rebuilt, and persists at once,
        // so this release and every later incarnation agree on the exact
        // prompt snapshot each session runs.
        const loaded = registry;
        const refreshed = loaded.map(refreshPresetEntry);
        if (refreshed.some((entry, index) => entry !== loaded[index])) {
          registry = refreshed;
          // A failed write is already logged by saveRegistry and must not
          // fail the load (which would leave every inbox unrevived this
          // boot): the refreshed entries are in memory, the next lifecycle
          // save persists them, and a crash before that re-derives them.
          await saveRegistry().catch(() => undefined);
        }
        return registry;
      })().catch(error => {
        registryLoadP = undefined;
        throw error;
      });
    }
    return registryLoadP;
  };
  // Serialize append-only lifecycle snapshots. Every registry version has a
  // unique name, so a crash leaves either the previous complete snapshot or the
  // next complete snapshot; it can never erase the sole recovery record.
  let registryWrite = Promise.resolve();
  const saveRegistry = () => {
    const result = registryWrite.then(async () => {
      const sequence = registrySequence;
      // Reserve the name before the remote write: a rejected acknowledgement
      // does not prove that storeValue failed to commit. Later saves must use
      // a new name rather than colliding forever with that uncertain snapshot.
      registrySequence += 1n;
      const name = `${REGISTRY_PREFIX}${`${sequence}`.padStart(20, '0')}`;
      await E(powers).storeValue(
        harden({
          version: 1,
          sequence,
          sessions: harden([...(registry || [])]),
        }),
        name,
      );
      await retireRegistryBackup();
      // Append-only was never meant to be unbounded: every lifecycle
      // transition wrote a snapshot and nothing removed one, so the factory
      // host's pet store accumulated a full copy of the session array per
      // operation and every cold start listed and sorted all of them. Trim
      // only after the new snapshot is durable, so the journal is never
      // momentarily empty, and keep a few behind it so a snapshot that turns
      // out to be unreadable is not the only record.
      if (sequence >= BigInt(REGISTRY_JOURNAL_DEPTH)) {
        const oldest = sequence - BigInt(REGISTRY_JOURNAL_DEPTH);
        const staleName = `${REGISTRY_PREFIX}${`${oldest}`.padStart(20, '0')}`;
        await E(powers)
          .remove(staleName)
          .catch(() => undefined);
      }
    });
    // Preserve rejection for the caller while keeping later writes possible
    // and recording failures even when callers discard their promise.
    registryWrite = result.catch(error => {
      console.error('[floot-factory] session registry save failed:', error);
    });
    return result;
  };

  // Per-session in-process streaming agent, built lazily over the session
  // guest's powers. provideGuest is idempotent, so this both creates a fresh
  // session guest and revives an existing one after a restart.
  /** @type {Map<string, Promise<any>>} */
  const agents = new Map();
  const getAgent = id => {
    let agentP = agents.get(id);
    if (!agentP) {
      agentP = (async () => {
        const host = getHost();
        const handleName = `session-${id}`;
        const agentName = `session-agent-${id}`;
        // provideGuest is idempotent (create-or-revive). The petname we pass
        // (and provideGuest's return value) bind to the guest's *handle* — a
        // mail-only facet that, after a restart, has none of the petstore/mail
        // control methods. So we pass an explicit agentName and look the
        // controlling *agent* up by that name to get the full guest facet for
        // the session's powers (the same agent fae runs its driver against).
        await E(host).provideGuest(handleName, { agentName });
        const sessionGuest = await E(host).lookup(agentName);
        // Introduce the user to the session under the petname "user" so the
        // agent can mail them directly (send/reply target "user"). The factory
        // host's own "@host" is the user — the @agent that provisioned the
        // factory — so copy it into the guest's petstore. A session's own
        // "@host" is this factory host, not the user, which is why a plain
        // send("@host") never reaches them. Idempotent: skip if already present
        // (the guest's petstore survives restarts).
        try {
          if (!(await E(sessionGuest).has('user'))) {
            await E(host).copy(['@host'], [agentName, 'user']);
          }
        } catch (err) {
          console.warn(
            `[floot-factory] could not register "user" for session ${id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
        // Resolve the session's preset to pick its system prompt and provision
        // its objects. The prompt was snapshotted into the registry at creation
        // (so catalog edits don't retroactively change live sessions); the
        // object set is read from the catalog by id (objects are provisioned
        // once and idempotency makes re-reads harmless).
        await loadRegistry();
        const entry = (registry || []).find(s => s.id === id);
        const preset = getPreset(entry?.presetId || DEFAULT_PRESET_ID);
        const sessionPrompt =
          entry?.systemPrompt || systemPrompt || preset.systemPrompt;
        await provisionPresetObjects(
          host,
          agentName,
          sessionGuest,
          id,
          preset.objects,
          codePath,
        );
        // Build (or reuse) the backend for this session's pinned model; an
        // unpinned session follows the factory's configured default.
        // Persisted legacy CLI sessions fail instead of bypassing admission.
        let agentConfig;
        /** @type {Map<string, any> | undefined} */
        let extraTools;
        if (entry?.backendId) {
          const backend = (await getHostedBackends()).get(entry.backendId);
          if (!backend) {
            throw Error(`Hosted backend "${entry.backendId}" is unavailable`);
          }
          // Runtime container-mount tools (designs/runtime-container-fs-mount.md):
          // let the session bind capabilities it holds into its sandbox
          // under /mnt/. Built before the tool catalog is pinned, so the
          // hosted thread's toolSetId covers them; armed below with the
          // adapter that turns the registrar's bind set into the backend
          // session's declared attaches.
          const mountKit = containerMountRegistrar.makeSessionKit({
            sessionId: id,
            sessionGuest,
          });
          extraTools = mountKit.tools;
          agentConfig = {
            provideHostedClient: async snapshot => {
              const toolSet = makeEndoToolSet(snapshot);
              const mountClient = makeHostedMountClient({
                id,
                backend,
                spec: harden({
                  sessionId: id,
                  model: entry.modelId || '',
                  reasoningEffort: entry.reasoningEffort || '',
                  systemPrompt: sessionPrompt,
                }),
                getToolSet: () => toolSet,
                dropOwnBinds: async () => {
                  for (const bind of await mountKit.list()) {
                    if (bind.heldByThisSession) {
                      // eslint-disable-next-line no-await-in-loop
                      await mountKit
                        .detach({ innerPath: bind.innerPath })
                        .catch(() => undefined);
                    }
                  }
                },
              });
              hostedMountClients.set(id, mountClient);
              // Arm first: the replay hands the adapter this session's
              // persisted binds, which the first create then declares —
              // a restart costs no recreate.
              await mountKit.arm({ clientKey: id, client: mountClient });
              await mountClient.start();
              return makeSendOnlyClient(mountClient.run);
            },
          };
        } else if (entry?.model === CLAUDE_CLI_MODEL_ID) {
          Fail`Legacy Claude CLI sessions are unavailable: provision an attested hosted backend with brokered credentials and verified tool isolation`;
        } else {
          // A thunk, not a resolved provider: `refreshCredentials()` clears
          // the factory's cache, and a session that had captured its provider
          // would keep using the token that provider was built with — the
          // rotation or revocation would reach only sessions opened after it.
          agentConfig = { provideProvider: () => getProvider(entry?.model) };
        }
        // A session may delegate only while its own depth leaves room. The
        // spawner is rebuilt on every revival rather than persisted, so the
        // durable record of the tree is the session registry alone.
        const sessionDepth = Number(entry?.subagentDepth) || 0;
        const oracle = await getAccountOracle();
        const agent = await makeStreamingAgent(
          sessionGuest,
          undefined,
          agentConfig,
          sessionPrompt,
          harden({
            maxToolRounds,
            ...(extraTools ? { extraTools } : {}),
            ...(sessionDepth < maxSubagentDepth
              ? { spawner: makeSessionSpawner(id, sessionDepth + 1) }
              : {}),
            ...(oracle
              ? { accountOracle: oracle, modelId: await sessionModelId(entry) }
              : {}),
          }),
        );
        // Each session is addressable by mail: start following its inbox.
        agent.startInbox();
        return agent;
      })().catch(async error => {
        agents.delete(id);
        const admin = backendAdmins.get(id);
        if (admin) {
          // A stop, not a deletion: the backend keeps the session's durable
          // workspace and state, so a revival that failed past this point —
          // an oracle lookup, say — can be revived again with them intact.
          try {
            await E(admin).terminate();
            backendAdmins.delete(id);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `Floot session ${id} setup and hosted-backend rollback failed`,
              { cause: cleanupError },
            );
          }
        }
        throw error;
      });
      agents.set(id, agentP);
    }
    return agentP;
  };

  // Opaque session facet handed to the UI. It exposes a streaming conversation
  // and a history replay, but never reveals the backing guest.
  /** @type {Map<string, object>} */
  const facets = new Map();
  const assertSessionReady = async id => {
    await loadRegistry();
    const entry = (registry || []).find(session => session.id === id);
    if (!entry) throw Error(`Unknown session "${id}".`);
    if ((entry.lifecycle || 'ready') !== 'ready') {
      throw Error(
        `Session "${id}" is not operable while lifecycle is ${entry.lifecycle}`,
      );
    }
    return entry;
  };
  const getFacet = id => {
    let facet = facets.get(id);
    if (!facet) {
      const turns = makeSessionTurnSlot(
        async (input, writer, signal, setHistory) => {
          await assertSessionReady(id);
          const agent = await getAgent(id);
          await agent.converse(input, writer, undefined, signal, setHistory);
        },
      );
      facet = makeExo('FlootSession', FlootSessionInterface, {
        async getInfo() {
          const entry = await assertSessionReady(id);
          return harden({
            id,
            title: entry?.title || '',
            createdAt: entry?.createdAt || 0,
            presetId: entry?.presetId || DEFAULT_PRESET_ID,
            model: entry?.backendId
              ? hostedModelId(entry.backendId, entry.modelId || '')
              : entry?.model || '',
            backendId: entry?.backendId || 'provider',
            modelId: entry?.modelId || entry?.model || '',
            reasoningEffort: entry?.reasoningEffort || '',
            lifecycle: entry?.lifecycle || 'ready',
          });
        },
        /**
         * Start a turn and hand back a handle to it. The daemon owns the turn:
         * it drains the reply channel locally and persists the result, so a
         * caller that stops observing — an unmounted component, a closed tab, a
         * dropped gateway — does not stop the work. Only `cancel()` does.
         *
         * This is the same authority the inbox path already has: a mail turn
         * runs against a daemon-side buffering writer and nobody's disconnect
         * can end it. Handing the reply channel itself to the browser gave the
         * UI turn a weaker guarantee than the mail turn, which is backwards.
         *
         * @param {string | object} input
         * @returns {object} a FlootTurn
         */
        startTurn(input) {
          return turns.start(input);
        },
        async getCurrentTurn() {
          await assertSessionReady(id);
          const current = turns.getCurrent();
          if (!current) return null;
          return current;
        },
        async getHistory() {
          await assertSessionReady(id);
          const agent = await getAgent(id);
          return agent.getHistory();
        },
        async getUsage() {
          await assertSessionReady(id);
          const agent = await getAgent(id);
          return agent.getUsage();
        },
        /**
         * This session's share of the account: the deployment-wide plan and
         * rate limits, plus what this conversation has spent at the current
         * list price. Reported per session because that is the granularity a
         * user asks about ("what is this chat costing?").
         *
         * @param {boolean} [refresh]
         */
        async getAccount(refresh) {
          const entry = await assertSessionReady(id);
          const oracle = await getAccountOracle();
          if (!oracle) {
            return harden({
              available: false,
              reason: `No account oracle is bound to "${accountOracleName}".`,
            });
          }
          if (refresh) await E(oracle).refresh();
          const agent = await getAgent(id);
          const [plan, rateLimits, rateCard, usage] = await Promise.all([
            E(oracle).getPlan(),
            E(oracle).getRateLimits(),
            E(oracle).getRateCard(),
            agent.getUsage(),
          ]);
          const modelId = await sessionModelId(entry);
          const cost = modelId
            ? await E(oracle).estimateCost(
                harden({
                  modelId,
                  inputTokens: BigInt(
                    Math.max(0, Math.trunc(usage.inputTokens || 0)),
                  ),
                  outputTokens: BigInt(
                    Math.max(0, Math.trunc(usage.outputTokens || 0)),
                  ),
                }),
              )
            : undefined;
          return harden({
            available: true,
            plan,
            rateLimits,
            rateCard,
            usage,
            ...(cost ? { cost } : {}),
          });
        },
        help() {
          return 'Floot session: startTurn(input) returns a FlootTurn — getStatus(), watch() for a disposable view stream, cancel(), whenFinished() — that runs on the daemon whether or not anyone is watching; getCurrentTurn() recovers { input, turn, history } or null; one UI turn may be outstanding; getHistory() replays the conversation; getUsage() returns cumulative { inputTokens, outputTokens, turns }; getAccount(refresh?) returns the plan, rate limits, and this session’s estimated cost; getInfo() returns { id, title, createdAt }.';
        },
      });
      facets.set(id, facet);
    }
    return facet;
  };

  const cleanupSessionResources = async entry => {
    const { id } = entry;
    const failures = [];
    const agentP = agents.get(id);
    if (agentP) {
      try {
        const agent = await agentP;
        // A hosted backend's admin/factory termination below is the
        // authoritative barrier for a quarantined native turn. Allow cleanup
        // to reach it; provider-only sessions still fail closed here.
        await agent.shutdown(Boolean(entry.backendId));
      } catch (error) {
        // Do not tear down the guest beneath live turn or inbox activity.
        throw new AggregateError(
          [error],
          `Floot session ${id} agent did not stop`,
          { cause: error },
        );
      }
    }
    // A container-mount recreate still in flight would otherwise create a
    // successor backend session underneath the teardown below.
    const mountClient = hostedMountClients.get(id);
    if (mountClient) {
      await mountClient.close();
      hostedMountClients.delete(id);
    }
    const admin = backendAdmins.get(id);
    if (admin) {
      try {
        await E(admin).terminate();
        backendAdmins.delete(id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (entry.backendId) {
      // Termination is a stop: it releases the slice, the mount, and the
      // lease and keeps the workspace and Codex state. Deletion removes those
      // through the factory's idempotent destroy, which first stops any
      // instance it still runs — so it also reaches a backend instance whose
      // admin facet died with an earlier incarnation of this factory. Not
      // while termination is refusing, though: a session with an unsettled
      // Endo tool call stays intact for the lifecycle retry.
      if (failures.length === 0) {
        try {
          const backend = (await getHostedBackends()).get(entry.backendId);
          if (!backend) {
            throw Error(`Hosted backend "${entry.backendId}" is unavailable`);
          }
          await E(backend.factory).destroy(harden({ sessionId: id }));
        } catch (error) {
          failures.push(error);
        }
      }
    }

    // A hosted/CLI teardown failure can mean a host-side Endo tool call is
    // still settling. Keep the session guest and its capabilities alive until
    // backend termination succeeds on a later lifecycle retry.
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Floot session ${id} backend did not fully clean up`,
      );
    }
    // Drop this session's container-mount attach references
    // (designs/runtime-container-fs-mount.md); a last reference releases its
    // 9P bridge and host mount name. Runs after the backend teardown above,
    // so no container still binds the mountpoints being released. Failing to
    // release a bridge must not strand the session record — the registrar
    // logs which key was orphaned, and the records are gone either way.
    try {
      await containerMountRegistrar.releaseSession(id);
    } catch (error) {
      console.error(
        `[floot-factory] could not release container mounts for ${id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    const host = getHost();
    for (const name of [`session-${id}`, `session-agent-${id}`]) {
      try {
        if (await E(host).has(name)) {
          await E(host).remove(name);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Floot session ${id} resources did not fully clean up`,
      );
    }
    agents.delete(id);
    facets.delete(id);
  };

  const finishSessionDeletion = async id => {
    const entry = (registry || []).find(session => session.id === id);
    if (!entry) return;
    try {
      await cleanupSessionResources(entry);
    } catch (error) {
      const current = (registry || []).findIndex(session => session.id === id);
      if (current >= 0) {
        const currentEntry = /** @type {any[]} */ (registry)[current];
        /** @type {any[]} */ (registry)[current] = harden({
          ...currentEntry,
          lifecycle: 'error',
        });
        await saveRegistry();
      }
      throw error;
    }
    registry = (registry || []).filter(session => session.id !== id);
    await saveRegistry();
    console.error(`[floot-factory] Deleted session "${id}"`);
  };

  /**
   * Create one session: its registry entry, its guest, and its running inbox
   * loop. Shared by the factory's public `createSession` and by the subagent
   * spawner, so a subagent session is an ordinary session that records which
   * session asked for it.
   *
   * @param {Record<string, any>} options
   * @returns {Promise<string>} the new session id
   */
  const provisionSession = async options => {
    await loadRegistry();
    const preset = getPreset(options.presetId || DEFAULT_PRESET_ID);
    const id = newSessionId();
    const { parentSessionId, subagentName, subagentDepth } = options;
    const delegationFields =
      parentSessionId === undefined
        ? {}
        : {
            parentSessionId: `${parentSessionId}`,
            subagentName: `${subagentName}`,
            subagentDepth: Number(subagentDepth),
          };
    let backendId;
    let modelId;
    const selectedModel = options.modelId || options.model || '';
    if (options.backendId && options.backendId !== 'provider') {
      backendId = `${options.backendId}`;
      modelId = `${options.modelId || ''}`;
    } else if (
      typeof selectedModel === 'string' &&
      selectedModel.includes(':')
    ) {
      [backendId, modelId] = selectedModel.split(/:(.*)/s, 2);
    }
    if (backendId) {
      const backend = (await getHostedBackends()).get(backendId);
      if (!backend) throw Error(`Unknown hosted backend "${backendId}"`);
      const models = await E(backend.factory).listModels();
      const chosen = models.find(candidate => candidate.id === modelId);
      if (!chosen) {
        throw Error(`Unknown model "${modelId}" for backend "${backendId}"`);
      }
      const projected = normalizeHostedModelDescriptor(chosen);
      const supportedEfforts = projected.reasoningEfforts;
      if (
        options.reasoningEffort &&
        !supportedEfforts.includes(options.reasoningEffort)
      ) {
        throw Error(
          `Unsupported reasoning effort "${options.reasoningEffort}" for ${backendId}:${modelId}`,
        );
      }
    }
    // Snapshot the preset's id and prompt so later catalog edits don't change
    // a live session. The object set is re-read from the catalog by id in
    // getAgent (objects are provisioned once, idempotently). A model is pinned
    // only when the caller chose a known one; otherwise the session follows
    // the factory's configured default model.
    const sessionPrompt = composeSessionSystemPrompt({
      presetPrompt: preset.systemPrompt,
      requestedPrompt: options.systemPrompt,
      delegated: parentSessionId !== undefined,
    });
    const entry = harden({
      id,
      title: options.title || 'New chat',
      createdAt: Date.now(),
      presetId: preset.id,
      systemPrompt: sessionPrompt,
      // A versioned preset records which prompt revision this session runs,
      // and a prompt the operator supplied is marked so no later migration
      // replaces it with the preset's (refreshPresetEntry). Entries that
      // predate the marker are safe to migrate: the deployment this preset
      // was ported from took no caller prompt at all.
      ...('promptVersion' in preset
        ? { presetPromptVersion: preset.promptVersion }
        : {}),
      ...(options.systemPrompt && parentSessionId === undefined
        ? { customPrompt: true }
        : {}),
      lifecycle: 'creating',
      ...delegationFields,
      ...(backendId
        ? {
            backendId,
            modelId,
            ...(options.reasoningEffort
              ? { reasoningEffort: `${options.reasoningEffort}` }
              : {}),
          }
        : isKnownModel(selectedModel)
          ? { model: selectedModel }
          : {}),
    });
    /** @type {any[]} */ (registry).push(entry);
    await saveRegistry();
    // Build the agent now so the new session immediately follows its inbox
    // (addressable by mail without waiting for a first UI turn) and its
    // preset objects are provisioned up front.
    try {
      await getAgent(id);
      const index = /** @type {any[]} */ (registry).findIndex(
        session => session.id === id,
      );
      const currentEntry = /** @type {any[]} */ (registry)[index];
      /** @type {any[]} */ (registry)[index] = harden({
        ...currentEntry,
        lifecycle: 'ready',
      });
      await saveRegistry();
    } catch (error) {
      const failed = (registry || []).findIndex(session => session.id === id);
      if (failed >= 0) {
        const failedEntry = /** @type {any[]} */ (registry)[failed];
        /** @type {any[]} */ (registry)[failed] = harden({
          ...failedEntry,
          lifecycle: 'error',
        });
      }
      // Recording the failure must not be able to skip the rollback: by this
      // point `getAgent` may have started the session's inbox loop, and only
      // `cleanupSessionResources` can stop it. Observe the write's outcome and
      // report it alongside, rather than letting it escape the catch.
      const markFailure = await saveRegistry().then(
        () => undefined,
        markError => markError,
      );
      // The agent deliberately stays in the map. `cleanupSessionResources`
      // shuts it down before removing the guest's pet names; dropping the
      // reference first would tear the guest out from under a live inbox loop
      // with nothing left that could ever stop it.
      try {
        await finishSessionDeletion(id);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError, ...(markFailure ? [markFailure] : [])],
          `Floot session ${id} creation and rollback failed`,
          { cause: cleanupError },
        );
      }
      if (markFailure) {
        throw new AggregateError(
          [error, markFailure],
          `Floot session ${id} creation failed and the failure could not be recorded`,
          { cause: markFailure },
        );
      }
      throw error;
    }
    console.error(
      `[floot-factory] Created session "${id}" (preset "${preset.id}"${
        entry.backendId
          ? `, backend "${entry.backendId}", model "${entry.modelId}"`
          : entry.model
            ? `, model "${entry.model}"`
            : ''
      })`,
    );
    return id;
  };

  /**
   * Delete one session and, depth-first, every subagent session beneath it. A
   * subagent that outlived its parent would keep an inbox loop (and a hosted
   * backend slice) alive with nobody left to read its replies.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  const releaseSession = async id => {
    await loadRegistry();
    const index = (registry || []).findIndex(session => session.id === id);
    if (index === -1) throw Error(`Unknown session "${id}".`);
    const children = (registry || []).filter(
      session => session.parentSessionId === id,
    );
    for (const child of children) {
      await releaseSession(child.id);
    }
    // `finishSessionDeletion` rebinds `registry`, so re-find rather than
    // reusing the index computed before the recursion.
    const current = (registry || []).findIndex(session => session.id === id);
    if (current === -1) return;
    /** @type {any[]} */ (registry)[current] = harden({
      .../** @type {any[]} */ (registry)[current],
      lifecycle: 'deleting',
    });
    await saveRegistry();
    await finishSessionDeletion(id);
  };

  // Layers of delegation a session tree may reach. 0 withholds the subagent
  // tools from every session.
  const maxSubagentDepth = (() => {
    const configured = env?.FLOOT_MAX_SUBAGENT_DEPTH;
    if (configured === undefined || configured === '') {
      return DEFAULT_MAX_SUBAGENT_DEPTH;
    }
    const value = Number(configured);
    if (!Number.isInteger(value) || value < 0) {
      throw Error(
        `Invalid FLOOT_MAX_SUBAGENT_DEPTH ${JSON.stringify(configured)}`,
      );
    }
    return value;
  })();

  // Provider calls one turn may make before the tool-step fallback. Read once
  // here, where a bad value is a deployment error the operator sees at
  // provisioning, rather than per session where it would surface as a failed
  // turn much later.
  const maxToolRounds = (() => {
    const configured = env?.FLOOT_MAX_TOOL_ROUNDS;
    if (configured === undefined || configured === '') {
      return DEFAULT_MAX_TOOL_ROUNDS;
    }
    const value = Number(configured);
    if (!Number.isInteger(value) || value < 1) {
      throw Error(
        `Invalid FLOOT_MAX_TOOL_ROUNDS ${JSON.stringify(configured)}`,
      );
    }
    return value;
  })();
  const MAX_SUBAGENTS_PER_SESSION = 8;

  /**
   * The whole of the authority a session gets over the factory: create, list,
   * and release sessions recorded as its own subagents. It cannot name, reach,
   * or delete any other session, and it never sees a session guest — the
   * locator it returns is the subagent's mail handle, which is exactly what
   * the parent needs to converse with it and nothing more.
   *
   * @param {string} parentId
   * @param {number} depth - Delegation depth of the subagents it creates.
   */
  const makeSessionSpawner = (parentId, depth) => {
    const listSubagents = async () => {
      await loadRegistry();
      return (registry || []).filter(
        session => session.parentSessionId === parentId,
      );
    };
    return makeExo('SubagentSpawner', SubagentSpawnerInterface, {
      /**
       * @param {string} name
       * @param {{ systemPrompt?: string }} [options]
       */
      async spawn(name, options = {}) {
        assertSubagentName(name);
        const { systemPrompt: childPrompt } = options;
        if (
          childPrompt !== undefined &&
          (typeof childPrompt !== 'string' || childPrompt.length > 32_768)
        ) {
          throw Error(
            'Subagent system prompt must be a string of at most 32768 characters',
          );
        }
        const siblings = await listSubagents();
        if (siblings.some(session => session.subagentName === name)) {
          throw Error(`Subagent "${name}" already exists.`);
        }
        if (siblings.length >= MAX_SUBAGENTS_PER_SESSION) {
          throw Error(
            `Subagent limit of ${MAX_SUBAGENTS_PER_SESSION} reached; stop one first.`,
          );
        }
        const parent = (registry || []).find(
          session => session.id === parentId,
        );
        // A subagent runs on the same backend and model as its parent: it is
        // extra context, not a way to reach a backend this session was not
        // provisioned for.
        const inheritedModel = parent?.backendId
          ? {
              backendId: parent.backendId,
              modelId: parent.modelId,
              ...(parent.reasoningEffort
                ? { reasoningEffort: parent.reasoningEffort }
                : {}),
            }
          : parent?.model
            ? { model: parent.model }
            : {};
        const childId = await provisionSession({
          title: `${parent?.title || 'Session'} / ${name}`,
          presetId: parent?.presetId,
          ...inheritedModel,
          ...(childPrompt ? { systemPrompt: childPrompt } : {}),
          parentSessionId: parentId,
          subagentName: name,
          subagentDepth: depth,
        });
        const locator = await E(getHost()).locate(`session-${childId}`);
        return harden({ name, locator });
      },

      /** @param {string} name */
      async stop(name) {
        assertSubagentName(name);
        await null;
        const entry = (await listSubagents()).find(
          session => session.subagentName === name,
        );
        if (!entry) throw Error(`No subagent named "${name}".`);
        await releaseSession(entry.id);
      },

      async list() {
        await null;
        const names = (await listSubagents())
          .map(session => `${session.subagentName}`)
          .sort();
        return harden(names);
      },

      /** @param {string} [methodName]  */
      help(methodName) {
        if (methodName === 'spawn') {
          return 'spawn(name, { systemPrompt? }) — Create a subagent session beneath this one and return { name, locator }.';
        }
        if (methodName === 'stop') {
          return 'stop(name) — Delete a subagent session and every session beneath it.';
        }
        if (methodName === 'list') {
          return 'list() — Names of this session’s live subagents.';
        }
        return 'Subagent spawner: create, list, and release sessions recorded as subagents of one parent session.';
      },
    });
  };

  // Revive every session's inbox loop after a restart, without blocking make()
  // (the reincarnation-deadlock constraint forbids awaiting remote refs here).
  // Fire-and-forget: load the registry and build each agent, which starts its
  // inbox loop. New sessions start their loops in getAgent at creation time.
  const startAllInboxes = async () => {
    const reg = await loadRegistry();
    for (const s of reg) {
      if (s.lifecycle === 'deleting' || s.lifecycle === 'error') {
        finishSessionDeletion(s.id).catch(error => {
          console.error(
            `[floot-factory] cleanup recovery failed for session-${s.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      } else {
        const recoverCreating = async () => {
          if (s.lifecycle === 'creating') {
            // `creating` is an incomplete transaction. Remove every resource
            // derivable from its stable session ID before provisioning anew.
            await cleanupSessionResources(s);
          }
          return getAgent(s.id);
        };
        recoverCreating()
          .then(async () => {
            if (s.lifecycle === 'creating') {
              /** @type {number} */
              const index = reg.findIndex(entry => entry.id === s.id);
              if (index >= 0) {
                reg[index] = harden({ ...reg[index], lifecycle: 'ready' });
                await saveRegistry();
              }
            }
          })
          .catch(error => {
            console.warn(
              `[floot-factory] could not start inbox for session-${s.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
    }
  };
  startAllInboxes().catch(error => {
    console.error(
      '[floot-factory] inbox revival error:',
      error instanceof Error ? error.message : String(error),
    );
  });

  return makeExo('FlootFactory', FlootFactoryInterface, {
    /**
     * @param {string | Record<string, any>} [titleOrOptions]
     * @param {string} [presetId]
     * @param {string} [model]
     * @returns {Promise<object>} an opaque session facet
     */
    async createSession(titleOrOptions, presetId, model) {
      const options =
        titleOrOptions && typeof titleOrOptions === 'object'
          ? titleOrOptions
          : {
              title: titleOrOptions,
              presetId,
              model,
            };
      // The delegation fields are minted by the spawner, never accepted from a
      // caller: a session that claimed another's parentage would join that
      // parent's subagent list and become stoppable by it.
      const {
        parentSessionId: _parentSessionId,
        subagentName: _subagentName,
        subagentDepth: _subagentDepth,
        ...publicOptions
      } = options;
      return getFacet(await provisionSession(publicOptions));
    },

    /**
     * @returns {Promise<Array<{ id: string, title: string, createdAt: number, presetId: string, model: string, backendId: string, modelId: string, reasoningEffort: string, lifecycle: string, parentSessionId: string, subagentName: string }>>}
     */
    async listSessions() {
      await loadRegistry();
      return harden(
        (registry || []).map(
          ({
            id,
            title,
            createdAt,
            presetId,
            model,
            backendId,
            modelId,
            reasoningEffort,
            lifecycle,
            parentSessionId,
            subagentName,
          }) => ({
            id,
            title,
            createdAt,
            presetId: presetId || DEFAULT_PRESET_ID,
            model: backendId
              ? hostedModelId(backendId, modelId || '')
              : model || '',
            backendId: backendId || 'provider',
            modelId: modelId || model || '',
            reasoningEffort: reasoningEffort || '',
            lifecycle: lifecycle || 'ready',
            // Empty for a session the user opened; set for one an agent
            // spawned, so a client can group or hide the delegated tree.
            parentSessionId: parentSessionId || '',
            subagentName: subagentName || '',
          }),
        ),
      );
    },

    /**
     * @returns {Promise<Array<{ id: string, title: string, description: string }>>}
     */
    async listPresets() {
      return harden(
        PRESETS.map(({ id, title, description }) => ({
          id,
          title,
          description,
        })),
      );
    },

    async listBackends() {
      const hosted = await getHostedBackends();
      return harden([
        harden({
          id: 'provider',
          title: 'LLM API',
          kind: 'api',
          continuity: 'explicit',
          toolOwnership: 'endo',
        }),
        ...[...hosted.values()].map(({ descriptor }) => descriptor),
      ]);
    },

    /**
     * The selectable models for a new session. `default` marks the model an
     * unpinned session runs (the factory's configured model, or the conventional
     * fallback when that is unset or not in the catalog).
     *
     * @param {string} [backendId]
     * @returns {Promise<Array<{ id: string, selectionId: string, backendId: string, modelId: string, title: string, description: string, default: boolean, defaultReasoningEffort: string | null, reasoningEfforts: string[] }>>}
     */
    async listModels(backendId) {
      if (backendId && backendId !== 'provider') {
        const backend = (await getHostedBackends()).get(backendId);
        if (!backend) throw Error(`Unknown hosted backend "${backendId}"`);
        const models = await E(backend.factory).listModels();
        return harden(
          models.map(candidate => {
            const projected = normalizeHostedModelDescriptor(candidate);
            return harden({
              id: hostedModelId(backendId, projected.id),
              selectionId: hostedModelId(backendId, projected.id),
              backendId,
              modelId: projected.id,
              title: projected.title,
              description: projected.description,
              default: projected.default,
              defaultReasoningEffort: projected.defaultReasoningEffort,
              reasoningEfforts: projected.reasoningEfforts,
            });
          }),
        );
      }
      let defaultModel = '';
      try {
        const cfg = await getProviderConfig();
        defaultModel = (cfg && cfg.model) || '';
      } catch {
        // Provider config not resolvable yet — fall back to the conventional
        // default so the picker still has a sensible pre-selection.
      }
      if (!isKnownModel(defaultModel)) defaultModel = DEFAULT_MODEL_ID;
      const providerModels = MODELS.map(({ id, title, description }) => ({
        id,
        selectionId: id,
        backendId: 'provider',
        modelId: id,
        title,
        description,
        default: id === defaultModel,
        defaultReasoningEffort: null,
        reasoningEfforts: [],
      }));
      if (backendId === 'provider') return harden(providerModels);
      const hosted = await getHostedBackends();
      const hostedModels = [];
      for (const [id, backend] of hosted.entries()) {
        try {
          const models = await E(backend.factory).listModels();
          hostedModels.push(
            ...models.map(candidate => {
              const projected = normalizeHostedModelDescriptor(candidate);
              return harden({
                id: hostedModelId(id, projected.id),
                selectionId: hostedModelId(id, projected.id),
                backendId: id,
                modelId: projected.id,
                title: projected.title,
                description: projected.description,
                default: false,
                defaultReasoningEffort: projected.defaultReasoningEffort,
                reasoningEfforts: projected.reasoningEfforts,
              });
            }),
          );
        } catch (error) {
          console.error(
            `[floot-factory] model catalog unavailable for backend ${id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return harden([...providerModels, ...hostedModels]);
    },

    /**
     * @param {string} id
     * @returns {Promise<object>} the session facet
     */
    async getSession(id) {
      await assertSessionReady(id);
      return getFacet(id);
    },

    /**
     * @param {string} id
     * @param {string} title
     */
    async renameSession(id, title) {
      await loadRegistry();
      const reg = registry || [];
      const idx = reg.findIndex(s => s.id === id);
      if (idx === -1) throw new Error(`Unknown session "${id}".`);
      // Entries are hardened, so replace rather than mutate in place.
      reg[idx] = harden({ ...reg[idx], title });
      await saveRegistry();
    },

    /**
     * @param {string} id
     */
    async deleteSession(id) {
      await releaseSession(id);
    },

    /**
     * Drop the memoized provider config and the providers built from it.
     *
     * A rotation (`SecretAdmin.replaceBase64`) or a revocation needs no help:
     * a turn re-reads the secret and the provider cache is keyed on the bytes,
     * so it reaches every open session by itself. What this is for is a change
     * to the *config* — a different host, provider kind, or default model
     * bound at `llm-provider` — which is read once and would otherwise need a
     * daemon restart. Sessions on a hosted backend are unaffected either way:
     * their credentials belong to the backend, not to Floot.
     */
    async refreshCredentials() {
      providersByModel.clear();
      providerConfigP = undefined;
      console.error(
        '[floot-factory] Dropped the cached provider config; the next turn re-reads it.',
      );
    },

    /**
     * The subscription plan, rate limits, and price list behind this
     * deployment's credential, as capability-free data.
     *
     * Every section carries `observedAt` and a `source` of observed, declared,
     * remembered, or unavailable, so a caller can tell a measurement from an
     * assertion. Counts are bigints — a published quota is a natural number
     * whose range is the provider's to choose.
     *
     * @param {boolean} [refresh] - Re-read the provider before answering.
     */
    async getAccount(refresh) {
      const oracle = await getAccountOracle();
      if (!oracle) {
        return harden({
          available: false,
          reason: `No account oracle is bound to "${accountOracleName}". Provision one to report plan and rate limits.`,
        });
      }
      if (refresh) await E(oracle).refresh();
      const [plan, rateLimits, rateCard] = await Promise.all([
        E(oracle).getPlan(),
        E(oracle).getRateLimits(),
        E(oracle).getRateCard(),
      ]);
      return harden({ available: true, plan, rateLimits, rateCard });
    },

    /**
     * The oracle itself, for a caller that wants to hold it — a monitor, or an
     * agent that should be able to check its own quota. It is read-only and has
     * no path to the credential, which is why handing it out is safe where
     * handing out the factory would not be.
     */
    async getAccountOracle() {
      const oracle = await getAccountOracle();
      if (!oracle) {
        throw Error(
          `No account oracle is bound to "${accountOracleName}" in this factory.`,
        );
      }
      return oracle;
    },

    /**
     * @param {string} [methodName]
     * @returns {string}
     */
    help(methodName) {
      if (methodName === undefined) {
        return 'Floot factory: createSession({title,presetId,backendId,modelId,reasoningEffort} | title?, presetId?, model?) -> session facet; listSessions() includes backend/model/reasoning/lifecycle metadata; listBackends(); listModels(backendId?); listPresets(); getSession(id); renameSession(id,title); deleteSession(id); refreshCredentials(); getAccount(refresh?); getAccountOracle(). Session facets expose startTurn() -> FlootTurn, getCurrentTurn() -> { input, turn } | null, getHistory(), getUsage(), and getInfo().';
      }
      const docs = {
        createSession:
          'createSession(options | title?, presetId?, model?) — Create an isolated session. Options can select title, presetId, backendId, modelId, and reasoningEffort. Returns its opaque facet.',
        listBackends:
          'listBackends() — Return the live provider and hosted backend descriptors.',
        listSessions:
          'listSessions() — Return metadata [{id, title, createdAt, presetId, model, backendId, modelId, reasoningEffort, lifecycle}] for all sessions.',
        listPresets:
          'listPresets() — Return the available session presets [{id, title, description}].',
        listModels:
          'listModels(backendId?) — Return backend-scoped models with compound selection ids and supported reasoning efforts; no argument returns the flattened compatibility catalog.',
        getSession: 'getSession(id) — Return the session facet for an id.',
        renameSession: 'renameSession(id, title) — Rename a session.',
        deleteSession:
          'deleteSession(id) — Delete a session, its backing guest, and every subagent session beneath it.',
        refreshCredentials:
          'refreshCredentials() — Re-read the `llm-provider` config on the next turn. A rotated or revoked secret needs no call: a turn reads it afresh.',
        getAccount:
          'getAccount(refresh?) — { available, plan, rateLimits, rateCard }. Each section carries observedAt and a source of observed | declared | remembered | unavailable; counts are bigints, and null means the provider does not publish that figure.',
        getAccountOracle:
          'getAccountOracle() — The read-only HostedAccount capability itself, for a holder that should be able to check plan and quota without reaching the credential.',
      };
      return docs[methodName] || `No documentation for method "${methodName}".`;
    },
  });
};
harden(make);
