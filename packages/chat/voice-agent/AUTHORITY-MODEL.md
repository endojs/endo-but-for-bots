# Field-agent authority model — *read-free / write-by-request*

This is the canonical statement of how the field agent's endowments are
classified and gated. The companion `endowments.test.mjs` **enforces** it: a
power added to `agent-caps.mjs` without a matching classification fails the
suite. (Asked for as "the usual free-to-read, must-request-to-write pattern,
documented … with a test suite enforcing absolutely all endowments of the
initial bot.")

## The pattern

> **Reads are free. Writes are requested.**
> Any capability that only *observes* is handed over whole — the agent (and any
> delegate it spawns) may call it freely. Any capability that *changes the world*
> is split: the agent holds only a `propose*` verb that mints a **confirmable
> proposal**; the real action runs only when a human holding that authority
> **confirms** it. The agent can *designate* an action; it can never *authorize*
> one.

Two ocap invariants hold this up:

1. **Designation is by object, never by string.** The agent acts on a thing by
   holding/navigating the object (a Far Remotable, reached by a web-key handle in
   its c-list) — never by passing a string id the server re-resolves against
   ambient authority. String designation is the Confused Deputy this whole model
   exists to avoid (Hardy / Tyler Close). See `homeassistant-trie.mjs` for the
   canonical c-list implementation.
2. **Confirmation is mandatory for every destructive action — including ones
   reached through a *shared* cap.** A mistranscribed "unlock the door" must never
   auto-fire. The holder of a destructive share self-confirms (the typo guard);
   the operator (root) confirms the agent's proposals.

## The endowment classes

Every verb the bot can ever hold is one of these. `endowments.test.mjs` asserts
the mapping is total (no unclassified verb) and that each verb's `reversible`
flag matches its class.

| Class | Meaning | Gate | Verbs |
| --- | --- | --- | --- |
| `read` | Observe only, no side effect | none (free) | `searchNotes` `readNote` `consult` `fetchUrl` `haFind` `haTree` `haState` `agentsList` `agentStatus` `fileList` `fileRead` `listTimers` `contactsSearch` `contactsGet` `listSpecialists` |
| `reversible` | Speculative; abortable mid-flight (barge-in retracts) | none (free, `reversible:true`) | `generateImage` |
| `scoped-write` | Write confined to the agent's **own** home folder (sandboxed) | none (immediate, but can't escape its dir) | `fileWrite` `publishSite` |
| `notify` | Low-blast-radius outward ping / scheduling | none (immediate) | `pushFeed` `pushPhone` `scheduleWakeup` `repeatEvery` `cancelTimer` |
| `propose` | **Destructive.** Agent only proposes; a human confirms | **confirmable proposal** (auto-confirmable via "don't ask again", except HA) | `proposeNoteEdit` `proposeEmail` `proposeSubAgent` `proposeSystemPrompt` `haAct` `proposeAddContact` `proposeEditContact` `proposeSpawnSpecialist` |
| `coarse` | The **grant is the authorization** — root over a *kernel-isolated sandbox* that can't reach the host or home LAN | grant-time only (no per-action confirm, *by design*) | `vmExec` `agentExec` |
| `delegate` | Hand an **attenuated** sub-bundle to a larger (Opus) agent or a **confined specialist** | none — the sub-agent is itself confined to the granted subset | `delegateTask` `askSpecialist` |
| `share` | Re-grant **one** power you hold as a named, **revocable** invite (monotonic delegation) | none — you may always re-share what you hold; revoke any time | `createInvite` |

### Why `coarse` exists (and is safe)

`vmExec` / `agentExec` run a shell immediately — no per-command confirm. That is
intentional: they are *root over a microVM persona that is kernel-isolated from
the host and the home LAN*. Holding (or being granted) the `vm` / `agents` power
**is** the authorization; the blast radius is the sandbox. You confirm once, at
grant time, by deciding whether to hand someone that power at all. This is the
same principle that lets a **specialist sub-agent** act autonomously within a
confined domain: confirmation moves to *provisioning* time.

### Why `propose` email actually sends now

`email` is `propose` class: the agent calls `proposeEmail` → a confirmable card.
Only on confirm does `EmailExec.send` run, which sends via the SMTP relay in
`~/.config/field-agent/email.json` (as `bot@danfinlay.com`), or drafts to the
vault outbox if no creds are set. The agent never sends unilaterally.

## The "don't ask again" auto-confirm layer

Confirmation is the default, but trust can accrue **deliberately and revocably**. A
`propose`-class action's confirmation card carries a **"don't ask again for this
kind"** checkbox. Ticking it on confirm records an **auto-confirm rule** keyed by
`(agent, kind)` — where `agent` is the node that *created* the proposal (`root`, or a
specialist) and `kind` is the proposal type (`note-edit`, `email`, `contact-add`, …).

Thereafter, a matching proposal from that agent **fires immediately** (mid-turn, so an
autonomous specialist can chain actions) instead of parking a card. Rules:

- are **persisted** (`~/.config/field-agent/auto-confirm.json`) so accrued trust
  survives restarts;
- are **scoped to the creating agent** — a rule the root agent earns does NOT let a
  *shared* cap auto-fire; each agent accrues its own;
- are **listed + revocable** from that agent's inventory (`listAutoConfirm` /
  `revokeAutoConfirm` on the cap → the Shares panel's "Auto-confirm rules" section).
  Revoking re-arms confirmation;
- **exclude `home-assistant`** (physical-world actions — locks!) **and
  `spawn-specialist`** (granting authority to a new agent) entirely — these always
  confirm. Per-entity HA autonomy is future work (needs per-cap attribution).

The agent never decides its own autonomy: it always only *proposes*. The auto-confirm
rule is the operator's prior, explicit, revocable consent — confirmation moved to the
moment trust was granted. This is the same principle as the `coarse` class (the grant
is the authorization) and how a spawned **specialist** earns domain autonomy.

## Adding a new endowment

1. Add the power to `POWERS` in `agent-caps.mjs` with its verbs.
2. Implement each verb. If it changes the world, it must return a `propose(...)`
   result (not perform the action) — unless it is genuinely `scoped-write`,
   `notify`, or `coarse`, in which case say so deliberately.
3. Add each verb to the `POLICY` map in `endowments.test.mjs`.
4. `node --test endowments.test.mjs` — green means every endowment is accounted
   for and the destructive ones are proven to only propose.

Run: `node --test packages/chat/voice-agent/endowments.test.mjs`
