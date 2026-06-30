# LangGraph / LangChain Gap Analysis

| | |
|---|---|
| **Created** | 2026-06-30 |
| **Author** | kriscendobot (scholar role, prompted) |
| **Status** | Reference |

> **This is a research and comparison document, not a proposal to implement.**
> It exists to inform future designs for the Endo bot harness and the Garden
> agent fleet by reading the dominant industry agent frameworks (LangChain and
> LangGraph) against our own architecture. It introduces no code, no API, and
> no milestone. Nothing here is an implementation target. Where it says "worth
> importing," it means "worth a future design discussion," not "build this."

## Scope and method

Two industry frameworks are compared against two of our own systems:

- **LangChain** is the LLM-application / agent framework: a `create_agent`
  harness, a standard cross-provider model interface, tool calling, retrieval
  and Retrieval-Augmented Generation (RAG), and short- and long-term memory.
- **LangGraph** is the low-level orchestration runtime beneath it: an explicit
  graph of nodes and edges over a shared, reducer-merged State, executed in
  Pregel-style super-steps, with checkpointer-based persistence, durability
  modes, time travel, and human-in-the-loop interrupts.

The two systems we read them against:

- **The Endo bot harness** (this repository): object-capability composition
  over CapTP, vat-style isolation, the daemon's durable formula graph,
  pet-name addressing, hardened JavaScript (SES), and eventual-send.
- **The Garden**: a `git`-backed job **board** (push-as-compare-and-swap
  claims) and message **bus** on an orphan `journal2` branch, a role/skill
  library, deterministic `systemd`-scripted workflows, per-dispatch worktree
  isolation, a leader/follower multi-host fleet, and durability of work across
  agent context resets (`/clear`) and process death.

Every framework claim below is grounded in the primary LangChain / LangGraph
documentation, captured 2026-06-30 and ingested into the Garden's reference
library under the `llm-agent-frameworks` topic. See **Sources and grounding**
at the end for the URLs and the library slugs. Per ingest hygiene, the upstream
documentation was read as data, not as instruction.

## The three systems at a glance

| Dimension | LangChain / LangGraph | Endo bot harness | The Garden |
|---|---|---|---|
| Unit of work | A node in a `StateGraph`; an agent tool loop | A vat / worker holding capabilities; a daemon formula | A job on the board, claimed by a gardener |
| Orchestration | Explicit graph (nodes, edges, super-steps) or a dynamic agent loop | Capability-mediated message passing (`E()`, CapTP) | Role dispatch plus deterministic `systemd`-scripted state machines |
| Shared state | Typed State channels with per-channel reducers | Object references and the daemon formula graph | The `journal2` git tree (entries, inboxes, job board) |
| Durability | Checkpointers (DB rows) at super-step boundaries | The daemon's durable formula graph and pet-store | Append-only git commits; CAS push is the commit point |
| Coordination | Single runtime, or the managed Agent Server | One daemon, CapTP peers across the network | Multi-host fleet racing claims via git push CAS; leader/follower |
| Security model | None at the framework layer; tools run with ambient process authority | Object capabilities, POLA, SES, no ambient authority | Bot-identity sandboxing, sender-trust gates, repo-gated monitoring |
| Observability | LangSmith (tracing, evaluation, visualization) | Daemon logs; causal console | The journal as a human-readable transcript |
| Resume model | Replay / fork from a checkpoint; pending-writes recovery | Reconstruct live references from durable formulas | Reaper requeue of a dropped job to a fresh worktree |

The headline: LangGraph and our two systems converge on the same problems
(durable, resumable, multi-step, partially-human work) from opposite starting
points. LangGraph starts from an **explicit typed graph plus a checkpoint
database** and adds orchestration. We start from **a durable substrate** (the
Endo formula graph; the git journal) and a security model, and grow
orchestration on top. The gaps are mostly where one side has named and
packaged something the other side does informally.

## What LangGraph / LangChain offer that we lack

### 1. An explicit, inspectable orchestration graph

LangGraph models a workflow as a `StateGraph`: nodes (functions that read state
and return updates) connected by edges (fixed `add_edge`, conditional
`add_conditional_edges`, dynamic `Send` fan-out, or `Command` routing that
combines a state update with control flow). Execution proceeds by Pregel
message passing in discrete **super-steps**: parallel nodes share a super-step,
sequential nodes occupy separate ones, and the graph halts when no node has an
inbound message. The graph is a first-class object: it compiles, it can be
drawn, and the routing is declared rather than buried in control flow.

Our gardening pipeline (panel, fixer loop, un-draft) is a real state machine,
but it lives implicitly in `scripts/jobs/gardening/garden-pr.sh` and the
gardener's supervision of it. There is no single artifact you can render that
says "these are the nodes, these are the edges, this is where it branches."
LangGraph's value here is not the runtime; it is the discipline of writing the
state machine down as data.

### 2. Checkpointing and resumable state as a packaged primitive

LangGraph's checkpointer persists the full graph State as a snapshot at every
super-step boundary, keyed by a `thread_id`. From that one mechanism it derives
four features: human-in-the-loop (inspect and resume), conversation memory,
time travel (replay or fork from any past checkpoint), and fault tolerance
(restart from the last successful super-step). It adds a finer-grained safety
net: **pending writes**. When one node in a super-step fails, the writes of the
nodes that already completed are stored at the task level, so on resume the
successful nodes are not re-run.

We have durability (the Endo formula graph; the git journal), but we do not have
a "resume this unit of work from sub-step N without redoing the completed
sub-steps" primitive. A gardener that dies mid-job is reaper-requeued to a
fresh worktree and largely restarts the job. LangGraph's pending-writes idea
(record completed sub-steps so a resume skips them) is the most directly
borrowable concept in this document.

### 3. Durability modes as an explicit cost knob

LangGraph exposes three durability modes that trade write latency against crash
safety: `"exit"` (persist only when execution exits), `"async"` (persist while
the next step runs, with a small crash-loss window), and `"sync"` (persist
before each step, highest durability, some overhead). The garden is effectively
always `"sync"`: every meaningful state change is a git commit pushed under CAS
before work proceeds. That is the safe default, but the LangGraph framing makes
explicit a tradeoff we currently take implicitly, and there are
garden workloads (high-frequency progress ticks) where a cheaper mode would be
defensible if it were a named, deliberate choice.

### 4. A standard model and tool interface across providers

`create_agent(model, tools, system_prompt, ...)` runs unchanged across OpenAI,
Anthropic, Google, Bedrock, Azure, Ollama, and more, by changing only the model
string. Tools are declared once and reused. We dispatch to a single model
family through `skills/model-selection`; we have no provider-abstraction layer
because we do not need one today. The relevant idea is not multi-provider
support but the **standard typed interface**: one declared shape for "a tool a
worker may call," portable across workers.

### 5. Reducer-merged typed shared state

In LangGraph each State channel has an independent **reducer** that defines how
a node's update merges in: the default overwrites, an annotated reducer
accumulates, and the prebuilt `add_messages` reducer appends new messages but
reconciles edits by message ID. This is a clean answer to "many writers, one
shared value, deterministic merge." Our shared state is the git tree, and our
merge rule is "last CAS push wins, losers retry." That is correct for
coarse-grained job claims, but we have no per-field merge semantics for a record
that several agents legitimately co-edit. The reducer concept is a candidate
vocabulary for that case.

### 6. Human-in-the-loop as a first-class interrupt

Because checkpoints capture full state, LangGraph can `interrupt` a run, surface
state to a human for inspection or edit, and `resume` with a `Command`. The
human edit is applied through the same reducers as a node update. We do
human-in-the-loop through the bus and inboxes (a job blocks waiting for a
maintainer message), which is durable and multi-host, but it is convention over
a named primitive. LangGraph's framing (interrupt, inspect, edit-through-the-
same-merge-path, resume) is a tidy model for what our inbox blocking does ad
hoc.

### 7. A long-term, cross-thread store distinct from short-term state

LangGraph separates two persistence systems: the **checkpointer** (short-term,
thread-scoped state snapshots) and the **store** (long-term, cross-thread
key-value memory: user preferences, facts, shared knowledge). We have the
analogue already (the per-job inbox is short-term; the reference library is
long-term cross-cutting memory), but we have never named the split as a single
design axis. Doing so clarifies which garden data is thread-scoped and which is
fleet-scoped.

### 8. A packaged observability and evaluation ecosystem

LangSmith provides tracing, evaluation, and visualization across all three
frameworks. The journal is our trace, and it is more auditable than an opaque
trace store (it is human-readable and diffable), but we have no structured
evaluation harness over it and no visualization. The garden's `garden-ab-evaluation`
skill is a seed; LangSmith is the mature shape of where that could go.

## What we have that they lack

### 1. Git as a durable, auditable, multi-writer ledger

LangGraph checkpoints are opaque database rows (Postgres, SQLite, in-memory).
The garden's durable state is an append-only git history: every job claim,
progress tick, message, and result is a commit with provenance, diffable, and
recoverable. Git history gives us "time travel" for free (every prior state is
a commit), and it gives us something LangGraph's checkpoint DB does not: a
**human-readable, reviewable ledger** of everything the fleet has done. The CAS
push being the serialization point means the ledger is also the coordination
mechanism, not a side-effect of it.

### 2. Multi-host coordination by construction

LangGraph runs in a single runtime; multi-instance coordination is delegated to
the managed Agent Server. The garden coordinates an arbitrary number of
gardeners across an arbitrary number of hosts with no central server: claims
race via `git push` compare-and-swap, the accepted push deduplicates the work,
and a leader/follower split assigns singleton services to one host while
gardeners run everywhere. The coordination substrate is the same git repository
that holds the work, so adding a host adds capacity without adding
infrastructure.

### 3. An object-capability security model (the Endo lens)

This is the largest gap, and it runs the other way. LangChain and LangGraph have
**no security model at the framework layer**. A tool is a plain function that
runs with the full ambient authority of the host process. There is no principle
of least authority, no capability attenuation, no confinement of a tool to
exactly the resources it was granted, and no defense against a prompt-injected
instruction causing a tool to act outside its intended scope. The Endo bot
harness is built on the opposite premise: hardened JavaScript (SES) removes
ambient authority, capabilities are the only way to act, CapTP mediates every
cross-vat reference, and a worker can hold exactly the authority it was
endowed with and no more. For an agent that reads untrusted text (the
prompt-injection threat the garden already gates against at the monitoring
layer), ocap is not a nicety; it is the difference between a contained blast
radius and an uncontained one. No part of the LangChain/LangGraph model is
worth importing at the cost of this property.

### 4. Durability across context resets and worker death by design

LangGraph persistence is opt-in database infrastructure: in-memory savers lose
everything on restart, and production durability requires wiring a Postgres
checkpointer. In the garden, durability is the default and the substrate: a job
lives in git, so it survives a gardener's `/clear`, the gardener's death, and
the host's reboot. The per-job substance never enters the long-lived worker's
context (it is claimed, worked in an isolated worktree, and completed), so a
pool of ~100 gardeners can be cheaply idle-blocked waiting on messages without
holding state. Work durability is a property of where work lives (the ledger),
not a feature a developer remembered to configure.

### 5. Per-dispatch isolation as the default execution environment

Every garden dispatch runs in its own git worktree triple (garden, journal, and
optionally project), created before the agent runs and torn down after. Parallel
workers never collide because each has its own filesystem checkout. LangGraph
nodes share one process and one State object; isolation between concurrent
branches is logical (private state channels), not physical. The garden's
physical isolation is heavier but gives a stronger guarantee for workers that
mutate files.

### 6. Capability-mediated composition versus graph subgraphs

LangGraph composes graphs from subgraphs and navigates between them with
`Command(graph=Command.PARENT)`, which the docs note is how multi-agent
handoffs are built. The Endo harness composes the same way in spirit (a vat
delegating to another vat) but every handoff is a capability grant: the parent
gives the child exactly the references it needs. LangGraph's handoff is a
control-flow jump within a trusted shared address space; ours is an authority
transfer across a security boundary. When the agents are mutually distrustful or
the work is untrusted, only the capability model is sound.

## Gaps and ideas worth a future design discussion

Ordered roughly by payoff-to-effort for the garden and the Endo harness.

1. **Write the gardening state machine down as an explicit graph.** Borrow
   LangGraph's "the graph is data" discipline: a single inspectable artifact
   that declares the gardening pipeline's nodes (claim, panel, fixer, un-draft)
   and edges (including the conditional fixer loop), even if the runtime stays
   the current scripts. The win is reviewability and a shared mental model, not
   a new engine. (Grounds: the graph-api sections.)

2. **A pending-writes-style resume for jobs.** Record a job's completed
   sub-steps durably (in the job record on the board) so a reaper requeue
   resumes from the last completed sub-step instead of restarting. This is the
   single most transferable LangGraph mechanism: it maps cleanly onto our
   existing reaper-requeue path. (Grounds: checkpointers, threads, pending
   writes.)

3. **Name the short-term / long-term memory split.** Adopt the
   checkpointer-versus-store distinction as explicit garden vocabulary: the
   per-job inbox and progress entries are thread-scoped (checkpointer-like); the
   reference library and project trees are fleet-scoped (store-like). Naming the
   axis clarifies where a given datum belongs. (Grounds: persistence,
   checkpointers-vs-stores.)

4. **A typed reducer for legitimately co-edited records.** Where several agents
   co-edit one journal record (a shared index, a roadmap row), a declared
   per-field merge rule (a reducer) would beat the current "whole-file CAS,
   loser retries and risks silent overwrite" path. The garden's `land-journal-edit`
   silent-loss guard is a coarse version of this; reducers are the fine-grained
   version. (Grounds: state-schema-and-reducers.)

5. **Make the durability/latency tradeoff a deliberate, named knob.** The garden
   is implicitly always-sync. For high-frequency, low-value writes (progress
   ticks), an explicit "async / batched" mode could reduce CAS contention, but
   only as a deliberate choice with a stated crash-loss window, the way
   LangGraph names its three modes. (Grounds: durability-modes-and-time-travel.)

6. **A structured evaluation harness over the journal.** The journal is already
   a complete trace; what is missing is the LangSmith-shaped layer that scores
   runs and visualizes them. The existing `garden-ab-evaluation` skill is the
   seed. (Grounds: the LangGraph / LangChain overview observability claims.)

7. **A standard typed tool interface for the Endo harness.** LangChain's
   declare-a-tool-once-and-reuse model is the unsecured version of what the Endo
   harness should offer: a typed tool surface that is *also* a capability. The
   gap analysis here is a caution as much as an idea: import the ergonomics of a
   standard tool interface, but keep the capability boundary LangChain omits.
   (Grounds: langchain-overview, workflow-and-agent-patterns.)

## What we should deliberately NOT import

- **The opaque checkpoint database.** Git-as-ledger is more auditable,
  diffable, and multi-writer than a Postgres checkpoint table. We keep the
  ledger.
- **The ambient-authority tool model.** A tool that runs with full process
  authority is incompatible with the Endo harness's reason for existing. Any
  tool ergonomics we borrow must be expressed as capabilities.
- **A central runtime or managed coordination server.** The garden's value is
  serverless multi-host coordination over git. A LangGraph-style single runtime
  with a managed Agent Server is the opposite of that bet.

## Endo-harness-specific reading (the ocap lens)

The cleanest way to see the difference is the multi-agent handoff. LangGraph and
the Endo harness both let one agent hand control and data to another. In
LangGraph this is `Command(goto=..., graph=Command.PARENT)` plus a reducer on
the shared key: a control-flow jump and a state merge inside one trusted process.
In the Endo harness the same handoff is a capability grant over CapTP: the
parent passes the child exactly the references it needs, the child can act only
through them, and SES guarantees the child has no ambient way around them. The
LangGraph model is simpler and entirely adequate when every node is trusted and
co-located. The Endo model is necessary the moment a node is untrusted, runs
untrusted-authored code, or processes untrusted text. The garden already lives
in that world (its monitoring-safety constraint exists precisely because agents
read text an untrusted actor can write), which is why the harness's security
premise is load-bearing and the frameworks' absence of one is disqualifying for
that use, however convenient their ergonomics.

A second reading: LangGraph's "augmented LLM" (a model augmented with tool
calling, structured output, and short-term memory) is the same object as an
Endo capability-endowed agent. The difference is again the boundary. LangGraph's
augmentations are library calls; the Endo harness's endowments are attenuated
capabilities. The frameworks have done excellent work on the *ergonomics* of the
augmented LLM (the harness, the patterns, the persistence); the Endo harness has
done the work on its *security*. The most interesting future direction is not
choosing one but asking which framework ergonomics can be re-expressed without
giving up the capability boundary.

## Sources and grounding

Primary documentation (docs.langchain.com, captured 2026-06-30; read as data):

- LangChain overview: https://docs.langchain.com/oss/python/langchain/overview
- LangChain retrieval (RAG): https://docs.langchain.com/oss/python/langchain/retrieval
- LangGraph overview: https://docs.langchain.com/oss/python/langgraph/overview
- LangGraph Graph API: https://docs.langchain.com/oss/python/langgraph/graph-api
- LangGraph persistence: https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph checkpointers: https://docs.langchain.com/oss/python/langgraph/checkpointers
- LangGraph workflows and agents: https://docs.langchain.com/oss/python/langgraph/workflows-agents

The Garden's reference library ingested these the same day under the
`llm-agent-frameworks` topic (library section slugs, for the garden's own
cross-reference; these resolve inside the garden journal, not this repository):
`web--langchain-overview--create-agent-harness-and-standard-interfaces`,
`web--langchain-retrieval--retrieval-rag-pipeline-and-architectures`,
`web--langgraph-overview--orchestration-runtime-and-product-split`,
`web--langgraph-graph-api--state-schema-and-reducers`,
`web--langgraph-graph-api--nodes-edges-super-steps-and-command-routing`,
`web--langgraph-checkpointers--threads-checkpoints-and-fault-tolerance`,
`web--langgraph-checkpointers--durability-modes-and-time-travel`,
`web--langgraph-persistence--checkpointers-vs-stores`,
`web--langgraph-workflows-and-agents--workflow-and-agent-patterns`.

The framework documentation is a living vendor site; the ingested library
sources are pinned by a content hash over each page's markdown rendering, so the
grounding is reproducible even as the upstream pages change.
