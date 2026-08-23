# @endo/exo-google-sheets

`makeExoSpreadsheet(client)` wraps an `@endo/google-sheets` client in hardened, passable spreadsheet facets.

The default `spreadsheet` facet reads only.
The separately minted `writer` facet can delegate read-only, append-only, and write-only facets, each of which can narrow to one tab or A1 range.
The host retains `control` to constrain scopes, adjust limits and polling, sever write authority (`revokeWrites()`), or revoke every facet (`revoke()`).

`follow(range)` is a polling async iterator, and it polls on a timer the host granted rather than an ambient one — pass `{ setTimeout }` to supply it, or `{ setTimeout: null }` to hand out facets that can read but cannot poll.
Push/webhook delivery, `SheetsService`, and `SpreadsheetStructure` are deliberately deferred.

## How the attenuation is arranged

The package is laid out so that what a facet can do is legible from what it was
built out of, rather than from conditions inside its methods.

| Module | Holds |
| --- | --- |
| `src/a1.js` | Nothing. A1 notation and part designations parsed as powerless data. |
| `src/powers.js` | The three authority classes — read, append, overwrite — each made from only the client operations it needs, plus the host policy and the revocable forwarders. |
| `src/facets.js` | The exos. Each maker takes power objects and no client, so `makeReader` provably cannot write. |
| `src/exo-google-sheets.js` | The one place a whole client is held: it takes the client apart and hands each power maker its share. |

Ambient authority is arranged the same way. `src/a1.js`, `src/powers.js`, and
`src/facets.js` name no global at all — the clock the request throttle refills
on and the timer `follow()` polls on both arrive as parameters, so a facet can
wait only because it was granted the ability to. `src/exo-google-sheets.js` is
the sole module that reads `Date.now` and `globalThis.setTimeout`, and only as
the defaults for `{ now, setTimeout }`; it is already the module entitled to a
live network client, so it is the honest place to be unconfined. Under a taming
or a test clock, pass your own and nothing below can reach past it.

The dependencies run one way and thin out as they go: `exo-google-sheets.js` is
the only module that names the client, `powers.js` is the only one that can
reach it, and `facets.js` imports no value from `powers.js` at all — only the
power makers' types, which do not survive to runtime. Everything a facet can do
arrived as an argument.

### Why `powers.js` is separate from `facets.js`

Because it makes the read-only claim cheap to check. Grep `facets.js` for
`client`, `access`, `revoke`, or any allowlist and you find nothing but prose:
a facet maker cannot reach the client, charge the throttle, or consult a
policy, since none of those are in its scope. "`makeReader` cannot write" is
settled by its parameter list. Folded into one module, the claim would soften
to "no method here happens to call the client" — true of the bodies as written,
and re-litigated on every edit.

Two further properties fall out of the split rather than having to be arranged:

- `writer.readOnly()` returns a reader over the *same* read power object the
  writer's own read methods use. The delegate's authority is a subset by
  identity, not by rebuilding a reader from raw operations and trusting the
  rebuild to have stayed narrower.
- The power objects carry `narrow`, `designate`, and `unscoped` — needed by the
  facets, callable by no guest. As locals in `powers.js` they are simply out of
  reach; as methods on an exo, each would be a thing to remember to withhold
  from the interface guard.

The cost is one indirection, and it is not the pola-io shape, where
`makeFileRW()` is itself the attenuated object. The difference is that a
`FileRd` is a local object whose surface is its API, whereas these facets are
passable exos whose surface is a published interface guard — so the plumbing an
attenuated object needs (a scope to compose, a revocable forwarder to pass
through) cannot live on the object without becoming part of what a remote guest
sees.

Two consequences worth stating plainly:

- **There is no read-only mode.** A reader is not a writer with writing turned
  off; it is an object built over powers that contain no write operation. Which
  facet a guest receives is the grant.
- **Narrowing mints, never masks.** `part('Tasks')` returns a fresh facet over
  powers bound to a smaller designation, in the shape of `pathlib`'s `/` — not
  a wider capability wearing a smaller label.

`part(designation)` is the mereological verb, and it is the primary way to
narrow: a part of a whole is a narrower whole of the same authority class, so
`spreadsheet.part('Tasks').part('A1:C10')` composes, and `part('Tasks!A1:C10')`
names both axes at once. `sheet(title)` and `range(a1)` remain as the explicit
spelling — `sheet` because it is the one designation `part` cannot read on its
own (a tab whose title is itself A1-shaped, such as a tab named `A1`).

The part axis and the authority axis are orthogonal, in both directions:
narrowing the part never widens the verbs, and attenuating the verbs never
widens the part. `writer.part('Tasks').writeOnly()` and
`writer.writeOnly().part('Tasks')` land in the same place.

To withdraw authority already handed out, `control.revokeWrites()` severs the
caretaker that the append and overwrite powers reach the client through, and
`control.revoke()` severs the read caretaker too. Both are one-way: there is no
method that restores revoked authority, because a revocation a holder can watch
flip back is not one.

The design owes its shape to [`@agoric/pola-io`](https://www.npmjs.com/package/@agoric/pola-io)
(`makeFileRW().readOnly()` mints a `FileRd`; `makeCmdRunner('git').subCommand(…)`
narrows a designation) and to the attenuation discipline written up in
[disciplined-python-attenuation](https://github.com/dckc/awesome-ocap/blob/ocap-style/style-guide/disciplined-python-attenuation.md),
whose rule for dry-run — "represented by withholding write authority, not by
passing write authority plus a boolean guard" — is the rule applied here.
