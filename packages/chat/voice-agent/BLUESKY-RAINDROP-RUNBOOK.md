# Invite Bluesky users by Raindrop — runbook

A new field-agent power (`bluesky`) that reads a **Raindrop.io** collection of Bluesky profile bookmarks,
mints each of those people their own **private namespace** on Agent C (the same per-user namespace any invitee
gets — their own home folder, chats, projects, an allowance through your providers, BYO inference), and delivers
each person their personal invite link **over Bluesky** (a private DM).

It's wired but **dormant until you drop two credentials** — no creds, no risk. Do steps 1–3, then try it from
chat ("preview", then "send").

---

## 1. Make a Raindrop collection of the people to invite

In Raindrop, make a collection (e.g. **"Bluesky invites"**) and add bookmarks pointing at the profiles —
`https://bsky.app/profile/<handle>` (or `.../profile/<did>`). Only `bsky.app/profile/...` links are picked up;
everything else in the collection is ignored. Duplicates are de-duped.

## 2. Get the two credentials

- **Raindrop test token** — https://app.raindrop.io/settings/integrations → create an app → open it → copy the
  **Test token** (authorizes against your own account; no OAuth dance).
- **Bluesky app password** — bsky.app → Settings → Privacy and Security → **App Passwords** → add one, and
  **enable "Allow access to your direct messages"** (a normal app password silently fails the DM API). Note your
  handle (e.g. `you.bsky.social`).

## 3. Drop them in the config (never in chat / never in code)

Create `~/.config/field-agent/bluesky-raindrop.json` (mode 600):

```json
{
  "raindrop":   { "token": "<raindrop test token>" },
  "bluesky":    { "identifier": "you.bsky.social", "appPassword": "xxxx-xxxx-xxxx-xxxx" },
  "deliver":    "dm",
  "collection": "Bluesky invites"
}
```

`deliver` default: `"dm"` (private link) · `"mention"` (public @-post with **no** link — just nudges them to DM
you) · `"none"` (mint only; links wait in the Shares panel for you to hand out). `messageTemplate` is optional
(`{url}` and `{handle}` are substituted).

```bash
chmod 600 ~/.config/field-agent/bluesky-raindrop.json
```

No restart needed for the config itself — it's read on each call. (A restart *was* needed once, to load the new
power; that's already done.)

## 4. Try it from chat

- **"Check the Bluesky invite status"** → `blueskyInviteStatus` tells you what's configured / still missing.
- **"List my Raindrop collections"** → `blueskyListCollections` (pick one if not using the default).
- **"Preview the Bluesky invites"** → `blueskyInvitePreview` — a **dry run**: who *would* be invited, deduped,
  marking anyone already invited. Mints nothing, sends nothing. **Always preview first.**
- **"Send the Bluesky invites"** → `blueskyInviteSend` — mints each person a namespace and DMs them their link.
  **Idempotent**: re-running skips anyone already invited and reuses their existing space. Throttled (~4 s
  between DMs) and capped (default 50/run) so the account isn't flagged.

---

## Notes & safety

- **Cap hygiene.** Each invite link carries a swissnum. It is built server-side and put **only** into that one
  recipient's private DM — never returned to the agent, never logged, never shown in chat. The verbs return
  counts only. (Same trust model as emailing an invite link; the `kazputer`/`email` powers already do this.
  Bluesky DMs are *not* end-to-end encrypted, so the chat-service operator can see the link — use `mention` mode
  if you'd rather no link transit a third party.)
- **Revocation.** Invited people are normal scoped caps — revoke any of them from the **Shares panel** (top-right).
- **Stable identity.** Each person is keyed by their Bluesky DID, so re-running never double-mints; the same
  person always lands in the same space.
- **DM etiquette.** Cold bulk DMs are the fastest way to get an account limited. Prefer inviting people you have
  some relationship with; the throttle + per-run cap are deliberate. Delivery stops on the first rate-limit error.

## Rollback

This shipped as a single merge on `field-preact` (branch `bluesky-raindrop-invite`). To remove it cleanly:
`git revert -m 1 <merge-sha>` (or `git reset --hard <pre-merge-sha>`) then `systemctl --user restart voice-agent`.
The feature is additive (one module + one power + one wiring block); reverting touches nothing else. Any config
file you created (`bluesky-raindrop.json`, `bluesky-invited.json`, `bluesky-policies.json`) just goes unused.
