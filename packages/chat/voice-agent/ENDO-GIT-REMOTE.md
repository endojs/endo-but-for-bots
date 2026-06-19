# Endo git-remote object — git/PR rights as passable, attenuable capabilities

Status: **design / vision** (dan, 2026-06-16). Near-term gitea-PR workflow is SHIPPED (see
`blacksmith_runner` memory); this is the next milestone it sets up.

## The idea

Today the Blacksmith's right to touch a repo is plumbing: a bwrap slice + a host-side gitea
token the *runner* holds. Permissions live in gitea ACLs and a shared secret. That's the
pre-ocap world.

The ocap-native version: **a git remote is an Endo object.** Git/PR operations are *methods*
on a passable, hardened object. Then **permission = the set of methods reachable on the facet
you were handed** — "correct by lexical construction," exactly like every other cap in the
stack (the HA trie, the agents roster, the toll-bridge purse). You don't grant "write access"
in an ACL; you hand someone an object on which `merge()` simply does not exist.

The headline case dan named: **endow the right to submit a pull request but NOT to merge it.**
That's a `contributor` facet — `{ listBranches, readFile, createBranch, push, openPullRequest,
comment }` — with no `merge`. Merging requires a `maintainer` facet. No token, no role string;
the authority *is* the object.

## Interface sketch

```js
// makeForge(backend) → a RepoRoot cap (holds everything). backend encapsulates the real
// gitea/git creds + endpoint — the HOLDER of any facet never sees the token, only methods.
const root = makeForge({ giteaUrl, repo, tokenPath });   // root: all rights

root.reader();        // → { listBranches, readFile, listPRs, readPR }                (read-only)
root.contributor();   // → reader + { createBranch, push, openPullRequest, comment }  (PR, NOT merge)
root.maintainer();    // → contributor + { merge, closePR, deleteBranch }
// root itself also has { addCollaborator, setDefaultBranch, ... } (admin)
```

- **Monotonic attenuation** (the stack's invariant): a `contributor` can re-share only a
  facet ⊆ what it holds — it can hand a sub-agent a `reader`, never a `maintainer`. A facet
  can't manufacture authority it wasn't given. `share()`/`revoke()`/`listShares()` work on
  these exactly as on every other node in `agent-caps.mjs`.
- **Credential encapsulation**: the token lives *inside* the object (closed over, like the
  ssh creds behind the agents-roster `exec`, or the GPU behind a GpuLease). Holding
  `contributor` lets you `openPullRequest(...)`; it does not leak the token, and there is no
  method to extract it. This is why "runner holds the token" (today) becomes "the agent holds
  a contributor facet" (tomorrow) — same protection, but now *delegable* and *revocable* and
  *visible in the delegation graph*.
- **Methods, not strings**: `openPullRequest({ branch, title, body })` returns a PR object
  (itself a cap) on which a reviewer with `comment`/`merge` can act. A PR is a first-class
  passable object you can hand to a specific reviewer.

## Why it fits the rest of the field

- **The Blacksmith stops being special.** Its confinement is no longer "bwrap + a runner that
  pushes on its behalf"; it's "it holds a `contributor` facet." Want a dev-agent that can only
  read? Hand it `reader`. Want it to be able to merge its own trivial PRs? Hand `maintainer`
  for one repo. The bwrap filesystem slice still confines *what code runs*; the forge object
  confines *what it can do to the repo*.
- **Social collateral.** A PR-submit right granted to an invitee is an edge in the same
  delegation graph as their inference allowance (see `SELF-IMPROVEMENT-ROADMAP.md` §3). Misuse
  is visible; revocation is one call.
- **Paid capabilities.** Compose a forge facet with a purse (`paid-capability.mjs`):
  "`openPullRequest` costs N tix," or "CI runs are metered." The toll-bridge and the forge are
  the same shape — `charge({amount,payee})` behind a method.
- **Remote / cross-host.** Because it's an Endo object, the repo can live on another vat and be
  *dialed over OCapN* (Iroh transport, see `iroh_v1_service_transport`). A contributor facet to
  a repo on `friky` is just a remote presence — "GitHub-like API" with no GitHub, no shared
  account, no central ACL server: merely passable objects.

## Migration path

1. **Wrap gitea** — `makeForge` over the gitea REST API + git (reuse the runner's proven
   `git -c http.extraheader` push + `POST /pulls` from `blacksmith-runner.mjs`). Ship `reader`/
   `contributor`/`maintainer` facets. The token is read once, host-side, and sealed inside.
2. **Re-point the Blacksmith** — the runner hands each task a `contributor` facet instead of
   doing the push/PR itself. (Or the in-slice agent holds it directly once the slice can carry
   an Endo cap — the `@endo/genie` seam in `endo_sandbox_genie_confinement`.)
3. **Make it a field-agent power** — `forge` joins the cap bundle in `agent-caps.mjs`; the
   Shares panel can mint "PR-but-not-merge to repo X for Bob." `describe().canMint` lists it;
   hand-off is copy/QR (never render the swissnum).
4. **OCapN remote** — publish the forge object over the noise/Iroh netlayer so a repo on
   another host is a dialable cap. This is the "github-like, but only passable objects" endgame.

## Open questions

- One forge object per repo, or a `Forge` root that vends `repo(name) → RepoRoot`? (Latter
  matches the HA-trie / agents-roster object-navigator pattern.)
- PR review threads as cap objects (so you can hand "comment on PR #7" to one reviewer)?
- Backing beyond gitea: a pure-Endo content-addressed store (no gitea at all) is the long tail —
  but gitea-wrapping is the pragmatic first cut.
