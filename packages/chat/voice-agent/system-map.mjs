// system-map.mjs — a machine-readable model of the WHOLE system: every power + its verbs, the roles +
// their default rings, the default endowment per agent type, and the canonical review/process flows.
// So an in-framework agent can introspect the system (via the `systemMap` tool) and GRAPH it accurately —
// agents, endowments, and the flow of review/escalation/billing — instead of guessing.

// The least-privilege STARTER ring a new invitee gets (kept here as the single source of truth; the
// server's /invite imports it).
export const STARTER_RING = ['reference', 'research', 'images', 'contact'];

// The canonical flows (nodes are agent types / states; edges are the steps). Structural, human+graph
// readable. Each flow: { name, summary, steps:[{from,to,via,gate?}] }.
export const SYSTEM_FLOWS = harden([
  { name: 'new-user invite', summary: 'least-privilege starter cap, with a back-channel + request-more escalation', steps: [
    { from: 'owner (root)', to: 'invitee (scoped cap)', via: 'mint starter ring (reference/research/images/contact)' },
    { from: 'invitee', to: 'owner inbox', via: 'messageOwner (back-channel)' },
    { from: 'invitee', to: 'owner inbox', via: 'requestAccess(power)', gate: 'owner approves → banner +Add (rescopeCap)' },
  ] },
  { name: 'propose-a-tool', summary: 'an agent/delegate builds a tool; the owner reviews the code before it is callable', steps: [
    { from: 'any agent', to: 'pending library', via: 'proposeTool (instance | class; pure-JS make(powers))' },
    { from: 'pending', to: 'admitted library tool', via: '/tools/review → admit', gate: 'OWNER reviews code' },
    { from: 'admitted tool', to: 'any granted agent', via: 'callCustomTool (SES-sandboxed; class = real Endo bundle, shareable)' },
  ] },
  { name: 'delegate / employ', summary: 'attenuated sub-agents run in-framework (traced); tools they build return as DATA', steps: [
    { from: 'orchestrator', to: 'Opus sub-agent', via: 'delegateTask(powers ⊆ yours)', gate: 'returns answer + proposedTools (review-gated)' },
    { from: 'orchestrator', to: 'role sub-agent', via: 'employ(role) — CodeMode, ring ∩ your powers, traced (incl. dev roles)' },
    { from: 'orchestrator', to: 'specialist', via: 'proposeSpawnSpecialist → confirm → persistent confined specialist; askSpecialist' },
  ] },
  { name: 'billing', summary: 'a prepaid metered purse; on exhaustion, three payment rails credit it', steps: [
    { from: 'every turn', to: 'purse (µUSD)', via: 'metered inference (real-time gate; no step limit)' },
    { from: 'exhausted', to: 'credited', via: 'owner-comp (free) | Stripe Checkout | ERC-7710 delegation (MetaMask advanced permissions)' },
    { from: 'paid connector', to: 'purse debit', via: 'market rate + 1% commission' },
  ] },
  { name: 'paid-services library', summary: 'a recurring scout grows the connector library; the owner provides keys', steps: [
    { from: 'scout (scheduled)', to: 'owner inbox', via: 'research top APIs → propose catalog entry (+ resale-ToS)' },
    { from: 'owner', to: 'live connector', via: 'provide API key (vault, server-side injected)', gate: 'resale: ok → resell+1% | byo → commission only' },
  ] },
]);

// Build the full system map from the live catalog (deps injected from agent-caps).
export const buildSystemMap = ({ ALL_POWERS, POWERS, META_POWERS, roleList, specialists = [] }) => harden({
  powers: ALL_POWERS.map(p => ({ name: p, label: (POWERS[p] && POWERS[p].label) || '', verbs: (POWERS[p] && POWERS[p].verbs) || [], meta: META_POWERS.has(p) })),
  agentTypes: [
    { type: 'entry agent (Agent C)', endowment: 'ALL powers', note: 'reads everything; only PROPOSES changes (each confirmed, or via a "don\'t ask again" rule). Helps set up new agents.' },
    { type: 'invitee (starter)', endowment: STARTER_RING, note: 'least-privilege stateless/read-only + a back-channel; can requestAccess for more.' },
    { type: 'role sub-agent', endowment: 'the role\'s ring ∩ the orchestrator\'s powers', note: 'confined CodeMode; analysis roles fan out; dev roles get a host/home dev ring; all traced.' },
    { type: 'specialist', endowment: 'its configured ring (⊆ spawner, minus meta)', note: 'persistent, own id/persona/invite-link.' },
    { type: 'delegate (Opus)', endowment: 'a named subset of the caller\'s powers', note: 'one level deep; returns proposed tools as data.' },
  ],
  roles: roleList(),
  specialists: specialists.map(s => ({ id: s.id, name: s.name, powers: s.powers })),
  flows: SYSTEM_FLOWS,
  note: 'Powers are attenuable + revocable caps behind an unguessable token; delegation is monotonic (you can only grant what you hold). Render this as a graph: agent types as nodes, endowments as their held powers, flows as the edges of review/escalation/billing.',
});
