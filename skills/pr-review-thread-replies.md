# Reply on PR review threads via gh api

## When to use

After addressing inline review comments, reply on each thread with a
one-to-three-sentence note citing the commit SHA(s) that addressed
it. This closes the loop without forcing the reviewer to re-walk the
diff.

## How

Find each thread's parent comment id:

```sh
gh api repos/<owner>/<repo>/pulls/<N>/comments --paginate \
  --jq '.[] | {id, path, line, user: .user.login}'
```

Reply on the thread (note: `replies` endpoint, not the parent
endpoint):

```sh
gh api repos/<owner>/<repo>/pulls/<N>/comments/<comment-id>/replies \
  --method POST \
  -f body="Addressed in <short-sha> (<commit-headline>).  <one-line
explanation if needed>."
```

For a deferral instead of an addressed item:

```sh
-f body="Following up in a separate PR.  <one-line reason>."
```

Then post a top-level summary comment via `gh pr comment <N>` listing
each item, the commit that addressed it, and any deferrals.

## Pitfalls

- Posting a reply to a thread by replying to the parent comment id
  via the *parent* endpoint creates a new top-level review comment,
  not a threaded reply. The `/replies` suffix is required.
- Bash heredocs and `-f body=` quoting interact poorly with backticks
  in the body. Escape with `\`...\`` or use `--field` and pass the
  body as a here-string.
- When a review comment lands on a JSDoc / TypeScript type
  annotation, fetch the comment's `diff_hunk` (it is included in the
  `comments` payload). The hunk shows what the type used to be, and
  the reviewer is almost always asking about what was lost in the
  refactor (e.g. a `typeof Foo.prototype.method` carried `this:
  Foo`; downgrading to `() => string` silently dropped that). The
  fix is usually to restore the missing piece structurally
  (`((this: Foo) => string)`), not to revert the whole annotation.
- **Inline comments visible in the browser are sometimes not yet
  indexed by the REST API.** When `GET /pulls/<N>/comments` returns
  `[]` and `GET /pulls/comments/<id>` returns 404 for a comment whose
  body, path, position, and reactjis are clearly visible on the PR
  page, the comment is real but not yet propagated to the REST index.
  This typically happens when the maintainer left the comments as
  draft-or-pending review state (no published `Review`) and the
  GraphQL/Events APIs see them but the REST `/comments` index does
  not. The `/replies` endpoint will 404 in this state, and `POST
  /pulls/<N>/comments` with `in_reply_to: <id>` rejects with `422
  pull_request_review_thread_id must be published or must have review
  with same author as comment`. The dispatch payload (which the
  conductor populates from the events API) is the authoritative
  source for the comment bodies, paths, and positions in this state.
  The fallback for posting fold-in replies is a single top-level PR
  comment via `POST /issues/<N>/comments` that maps each comment id
  to its outcome (applied + commit SHA, stalled + reason, or
  replied-only). Cite the maintenance state in the top-level comment
  ("the inline-reply REST endpoints currently 404 against these
  comment ids -- a transient GitHub indexing glitch -- so this
  top-level comment carries the per-thread outcomes") so the
  maintainer knows why the threads themselves don't show resolution
  notes. Session example: PR 111's eight kriskowal inline comments
  on 2026-05-07 06:39-06:53 UTC; the dispatch payload carried
  bodies and positions, the `/replies` endpoint 404'd, and the
  `/issues/111/comments` top-level summary became the load-bearing
  reply. Eyes-reactjis on the comment ids worked from the same
  endpoint that 404'd on read, confirming the comments were
  reachable for some POSTs but not GETs.

## Session example

PR 59's seven inline review threads each received a `kriscendobot`
reply citing the commit SHA that addressed it (e.g., "Addressed in
`52f79b3e99` (refactor(ocapn-noise): clarify mock transport's
pair-of-pipes). The mock already composes two independent
unidirectional pipes; renamed the helper to `makeUnidirectionalPipe`
…"). PR 64 and PR 68 followed the same pattern.
