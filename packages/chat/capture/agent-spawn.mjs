// agent-spawn.mjs — the capability to PROPOSE spawning a sub-agent for a sub-task.
//
// The input agent cannot spawn or contact the outside world directly — it can
// only PROPOSE. A spawn proposal lands on the dashboard "Needs your input" for
// the operator to approve. On approval (future) the sub-agent is created under
// the spawner's folder with exactly the granted objects.
//
// Delegation rule (encoded in help() + the agent docs): break off any sub-task
// that can be done WITHOUT dan's private knowledge (the Obsidian graph / personal
// data) and propose a separate, less-privileged agent for it — proposing the
// objects it needs and noting anything the operator must gather (API docs,
// credentials to additional services).

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const H = x => (typeof harden === 'function' ? harden(x) : x);
const PROPOSALS = path.join(os.homedir(), '.local/state/field-dashboard/proposals.json');

const stamp = () => new Date().toISOString();

// Known grantable powers: short keys the caller passes in grantedPowers that
// map to concrete endowment specs baked into the sub-agent's bootstrap.json.
// The sub-agent's spawn-runner prompt lists each power with its invocation.
export const KNOWN_POWERS = {
  push: {
    Notify: {
      desc: "Push a notification to dan's phone via self-hosted ntfy (tailnet-only)",
      script: '/home/dan/endo-bfb/packages/chat/capture/notify.mjs',
      usage: "node <script> --title 'T' --message 'M' [--priority high|default|low] [--click URL]",
    },
  },
  postToFeed: {
    PostToFeed: {
      desc: 'Post an outcome entry to the agent feed on the dashboard',
      script: '/home/dan/endo-bfb/packages/chat/dashboard/feed.mjs',
      usage: "node <script> post --title 'T' --body 'B' [--status 'S'] [--agent 'name']",
    },
  },
};

// plain core
export const proposeSpawn = async ({ agentName = 'capture-agent', agentDir, name, task, prompt = '', caps = [], prereqs = [], grantedPowers = {} }) => {
  if (!name || !task) throw new Error('proposeSpawn needs {name, task}');
  const subFolder = `${agentDir ? agentDir.replace(/^.*the field\//, '') + '/' : 'agents/capture-agent/'}${name}`;
  const capList = (Array.isArray(caps) ? caps : [caps]).filter(Boolean);
  const preList = (Array.isArray(prereqs) ? prereqs : [prereqs]).filter(Boolean);
  const ctx = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
  const powersDesc = Object.keys(grantedPowers).length
    ? Object.entries(grantedPowers)
        .filter(([, v]) => v)
        .map(([k]) => (KNOWN_POWERS[k] ? Object.keys(KNOWN_POWERS[k]).join(', ') : k))
        .join(', ')
    : '(none)';
  const body = [
    `**Task:** ${task}`,
    `**Sub-agent folder:** \`${subFolder}/\` (+ \`/scratch/\`)`,
    `**Capabilities requested:** ${capList.length ? capList.join(', ') : '(none beyond default)'}`,
    `**Granted powers:** ${powersDesc}`,
    `**You may need to gather:** ${preList.length ? preList.join('; ') : '(nothing noted)'}`,
    ctx ? `**Context (selected from the agent's messages):**\n${ctx.slice(0, 2000)}` : '',
  ].filter(Boolean).join('\n\n');

  let store = { updated: '', proposals: [] };
  try { store = JSON.parse(await fsp.readFile(PROPOSALS, 'utf8')); } catch { /* fresh */ }
  if (!Array.isArray(store.proposals)) store.proposals = [];
  const id = `spawn-${stamp()}-${crypto.randomBytes(3).toString('hex')}`;
  store.proposals.push({
    id, date: stamp(), agent: agentName, source: `${agentName} delegation`,
    kind: 'spawn-agent', title: `Spawn sub-agent: ${name}`, body,
    code: '', endowment: JSON.stringify({ subAgent: name, folder: subFolder, caps: capList, prereqs: preList, task, prompt: ctx, grantedPowers }),
    status: 'pending',
  });
  store.updated = stamp();
  await fsp.mkdir(path.dirname(PROPOSALS), { recursive: true });
  await fsp.writeFile(PROPOSALS, JSON.stringify(store, null, 2));
  return { ok: true, id, subFolder };
};

// endo object — the spawn capability handed to the agent. Far loaded lazily so
// the plain core + CLI run without SES.
export const makeAgentSpawner = async ({ agentName = 'capture-agent', agentDir } = {}) => {
  const { Far } = await import('@endo/marshal');
  return Far('AgentSpawner', {
  help: () => H(
    'PROPOSE spawning a sub-agent (you cannot spawn directly — the operator approves on the ' +
    'dashboard). DELEGATION RULE: break off any sub-task that can be done WITHOUT dan\'s private ' +
    'knowledge (the Obsidian graph / personal data) and propose a separate, least-privileged ' +
    'agent for it. propose({ name, task, prompt, caps, prereqs, grantedPowers }): name = sub-agent ' +
    'name; task = what it should do; prompt = the relevant context selected from your own messages, ' +
    'e.g. `messages[messages.length-1]`; caps = the objects it will need (e.g. ["Scratchpad","FetchLink"]); ' +
    'prereqs = anything the operator must gather (API docs, credentials to additional services). ' +
    'grantedPowers = optional object of powers to share: { push: true } gives the sub-agent the ' +
    'Notify capability (ntfy push to dan\'s phone); { postToFeed: true } gives PostToFeed (post to ' +
    'the agent feed dashboard). Both can be granted together.'),
  propose: async args => H(await proposeSpawn({ agentName, agentDir, ...args })),
  });
};

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = { caps: [], prereqs: [] };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 1) {
    if (!v[i].startsWith('--')) continue;
    const k = v[i].slice(2); const val = v[i + 1] && !v[i + 1].startsWith('--') ? v[(i += 1)] : 'true';
    if (k === 'caps' || k === 'prereqs') a[k] = val.split(/\s*;\s*|\s*,\s*/).filter(Boolean);
    else a[k] = val;
  }
  const r = await proposeSpawn({
    agentDir: `${process.env.HOME}/obsidian/vault/the field/agents/capture-agent`,
    name: a.name, task: a.task, prompt: a.prompt || '', caps: a.caps, prereqs: a.prereqs,
  });
  console.log(JSON.stringify(r));
}
