#!/bin/bash
# Fetch every PR (open + closed) on endojs/endo into changes/<N>.md.
# Idempotent: existing non-empty files are skipped.
# Parallelism via xargs -P; gh is authenticated and well under the 5000/hr limit.

set -u
cd "$(dirname "$0")/.."

mkdir -p changes

TEMPLATE='# #{{.number}}: {{.title}}

- **URL:** {{.url}}
- **State:** {{.state}}
- **Author:** @{{.author.login}}
- **Created:** {{.createdAt}}
- **Updated:** {{.updatedAt}}
- **Closed:** {{.closedAt}}
- **Merged:** {{.mergedAt}}
- **Base:** {{.baseRefName}}
- **Head:** {{.headRefName}}
- **Draft:** {{.isDraft}}
- **Files:** {{.changedFiles}} (+{{.additions}} −{{.deletions}})
- **Labels:** {{range $i, $l := .labels}}{{if $i}}, {{end}}`{{$l.name}}`{{end}}

## Description

{{.body}}

## Commits ({{len .commits}})
{{range .commits}}
- `{{.oid}}` {{.messageHeadline}}{{end}}

## Reviews ({{len .reviews}})
{{range .reviews}}
---

### @{{.author.login}} — {{.state}} — {{.submittedAt}}

{{.body}}
{{end}}

## Comments ({{len .comments}})
{{range .comments}}
---

### @{{.author.login}} ({{.authorAssociation}}) — {{.createdAt}}

{{.body}}
{{end}}
'

fetch_one() {
  local num="$1"
  local out="changes/${num}.md"
  if [ -s "$out" ]; then
    return 0
  fi
  if gh pr view "$num" -R endojs/endo \
       --json number,title,body,author,createdAt,updatedAt,closedAt,mergedAt,state,labels,comments,reviews,commits,url,baseRefName,headRefName,isDraft,additions,deletions,changedFiles \
       --template "$TEMPLATE" > "$out" 2> "changes/${num}.err"; then
    rm -f "changes/${num}.err"
    return 0
  else
    echo "FAIL $num: $(cat changes/${num}.err 2>/dev/null)" >&2
    return 1
  fi
}
export -f fetch_one
export TEMPLATE

numbers=$(gh pr list -R endojs/endo --state all --limit 5000 --json number --jq '.[].number')
total=$(echo "$numbers" | wc -l)
echo "Fetching $total PRs into changes/ with -P 8 ..."

echo "$numbers" | xargs -n 1 -P 8 -I {} bash -c 'fetch_one "$@"' _ {}

done_count=$(ls changes/*.md 2>/dev/null | wc -l)
fail_count=$(ls changes/*.err 2>/dev/null | wc -l)
echo "Done: $done_count/$total ($fail_count failed)"

# Stamp the directory with the time of the last successful fetch.
# Other agents read changes/LAST-FETCHED to decide whether the
# snapshot is fresh enough to act on.  Excluded from the file count
# is LAST-FETCHED itself, so the number reflects PR mirror entries.
{
  echo "last-fetched: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "source: endojs/endo (pull requests, state=all)"
  echo "files: $done_count (failed=$fail_count)"
  echo "script: scripts/fetch-prs.sh"
} > changes/LAST-FETCHED
