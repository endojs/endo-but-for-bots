# @endo/exo-google-sheets

`makeExoSpreadsheet(client)` wraps an `@endo/google-sheets` client in hardened, passable spreadsheet facets.

The default `spreadsheet` facet reads only.
The separately minted `writer` facet can delegate read-only, append-only, and write-only facets, each of which can narrow to one tab or A1 range.
The host retains `control` to constrain scopes, adjust limits and polling, sever write authority (`revokeWrites()`), or revoke every facet (`revoke()`).

`follow(range)` is a polling async iterator.
Push/webhook delivery, `SheetsService`, and `SpreadsheetStructure` are deliberately deferred.

## How the attenuation is arranged

The package is laid out so that what a facet can do is legible from what it was
built out of, rather than from conditions inside its methods.

| Module | Holds |
| --- | --- |
| `src/a1.js` | Nothing. A1 notation parsed as powerless data. |
| `src/powers.js` | The three authority classes — read, append, overwrite — each made from only the client operations it needs, plus the host policy and the revocable forwarders. |
| `src/facets.js` | The exos. Each maker takes power objects and no client, so `makeReader` provably cannot write. |
| `src/exo-google-sheets.js` | The one place a whole client is held: it takes the client apart and hands each power maker its share. |

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
