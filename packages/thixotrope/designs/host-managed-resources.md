# Host-managed resources and workspaces that hold references

Status: proposed.
This note gathers the system changes suggested while reviewing #1220 so they are not lost.
None is implemented; each names what exists today, what should change, and what it costs.

## The model

A **workspace** is a user's inventory plus a few things of the user's own: a mailbox and its
contacts, and whatever control surfaces the user has been handed.
It holds **references** to resources; it does not manage them.
Resources, native or host, are **managed by the host**: the host allocates their vats, launches and
retires their processes, delivers their start notices, and indexes them.
A workspace therefore has no code of its own beyond an observable map and an address book, and
nothing in it needs a version bump when the host's bookkeeping changes shape.

Today the code is close to this for native resources at runtime and far from it for bookkeeping.
The host already allocates the manager vat, owns the adapter launcher (a host resource described by
the manager's worker id), delivers the start notice and drives removal.
But the **installation registry** that indexes every installation lives in the workspace vat's
heap, so an installation is scoped to one workspace and managed through that workspace.

## 1. Move the installation registry out of the user's workspace

What the registry in the workspace implies today:

- An installation is scoped to one workspace.
  The same native directory installed from two workspaces is two manager vats and two adapter
  processes, which for HTTP is two attempts to bind the same port.
- The host cannot manage installations without that vat.
  `installations`, `remove` and start-phase retries all evaluate in the workspace, so a quarantined
  workspace leaves every installed vat running and unremovable.
- The retention root for every installed vat is the workspace; retiring the workspace makes them
  all collectible.
- The registry's shape is frozen into heap closures, which is why every change to it is a
  `WORKSPACE_VERSION` bump with migrate-or-fresh.
- The one real benefit of being in a vat: the factory-result promise is guest-to-guest, so an
  application whose `make` is still pending across a host restart settles afterwards instead of
  being aborted as a host answer.

Proposal: one **registry vat per daemon**, owned by the host, holding the same registry closure.
The host installs native resources and applications through it; the install phases keep their
guest-to-guest factory promise; a workspace receives a reference to the installed value as a
grant into its inventory, exactly as applications receive grants today.
The host keeps a small durable index of its own (name, kind, digest, allocation key, worker id,
status) beside the vat, so `installations` and `remove` work when the registry vat is quarantined
and so retention of installed vats does not hang off any user's workspace.
Native resources become one per daemon; a workspace gets the facet, or a per-workspace sub-facet
the manager hands out when a resource must be partitioned between users.

Cost: a workspace version bump; `install.js` addressed at the registry vat rather than the
workspace; the supervisor's `provide` of the clock and mailbox moves with it.

## 2. Many workspaces, one by default

Today a state directory has exactly one workspace: `workspace.json` records one worker id and the
publication `workspace-<id>`, the administration facet is bound to it, and the clock, mailbox and
address book are provided into it.
A daemon that hosts many users needs many.

Proposal: a workspace table keyed by name, each entry with its own vat, publication, inventory,
address book, and provided mailbox, allocated under an **allocation key** rather than the
`workspace` debug label (the label is identity in one place today, `supervisor.js` first start).
The control connection selects a workspace by name and `thix` takes `--workspace NAME`;
`serve` creates one named `default` unless told otherwise.
The hub, the peers socket, the alarm ledger and the registry vat of section 1 stay shared.

Cost: `workspace.json` becomes a table; the admin facet becomes per workspace; the TUI and the CLI
gain a selector.

## 3. The control socket stays host code

The operator's control socket is a fresh OCapN session per connection whose first object is the
administration facet.
It is the operator's full authority over the workspace and the daemon, and it is host code, so it
works when vats are broken: a quarantined workspace, an exhausted manager or a bad bundle are the
cases `thix attach` and `thix status` exist for.
Modelling the socket as a native resource would route repair through the thing being repaired, so
it stays in the host.
The adapter half of the kit could still own the listening socket if one listener implementation is
wanted, with the admin facet served by the host.

Two smaller changes follow:

- The README and the root design describe inventory views as receiving "descriptions, never the
  values", which reads as confinement.
  It is a representation choice for a text view whose session ends with the connection; the
  operator already holds everything.
  Reword both.
- `evaluate` returns a rendered string, so an operator cannot hold a value from one command to the
  next except through the inventory.
  The session is already OCapN; the admin facet could return references and render client-side.

## 4. Typed resource descriptions

A resource description is the static constructor argument of a host resource: any passable value,
memoised and persisted as `(name, JSON(description))`.
Each maker defines the shape it expects (`{ workerId }` for alarms and worker facades,
`{ moduleUrl, resourceIdentity }` for an adapter launcher), but nothing types it.
Proposal: a description type per resource name, so maker signatures and `retireResource` take a
checked argument, and the launcher's read-side fallback for the field renamed this session can
retire once no pre-rename state directories remain.

## 5. Smaller items

- `alarmStatus` flattens bigint counts to `Number` for the JSON the CLI prints; `status` uses
  strings for its counts. One convention for counts over the control socket.
- Node replay doubles load the guest prelude as host modules, so environment options those
  packages read (`ENDO_RANK_STRINGS`, `DEBUG`) must be the same across runs that share a journal.
  Either pin them in the doubles or document the constraint where the doubles are configured.
- The manager kit's `describe` receives no spec for a closed registration; the HTTP facet could
  carry a `closedAt` or similar if views want it.
- `installNative` returns the installation record; `thix install` prints it. A `thix install`
  retry that hits "name has a different installation" should say what differed.

## Order

1. Section 1, since sections 2 and 3 are simpler once installations are the host's.
2. Section 2.
3. Section 4 and the documentation rewording in section 3.
4. Section 5 as they come up.
