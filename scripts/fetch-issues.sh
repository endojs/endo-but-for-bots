#!/bin/bash
set -u
cd "$(dirname "$0")/.."

mkdir -p issues

TEMPLATE='# #{{.number}}: {{.title}}

- **URL:** {{.url}}
- **State:** {{.state}}
- **Author:** @{{.author.login}}
- **Created:** {{.createdAt}}
- **Updated:** {{.updatedAt}}
- **Labels:** {{range $i, $l := .labels}}{{if $i}}, {{end}}`{{$l.name}}`{{end}}

## Description

{{.body}}

## Comments ({{len .comments}})
{{range .comments}}
---

### @{{.author.login}} ({{.authorAssociation}}) — {{.createdAt}}

{{.body}}
{{end}}
'

numbers=$(gh issue list --state open --limit 1000 --json number --jq '.[].number')
total=$(echo "$numbers" | wc -l)
done_count=0
fail_count=0

for num in $numbers; do
  out="issues/${num}.md"
  if [ -s "$out" ]; then
    done_count=$((done_count + 1))
    continue
  fi
  if gh issue view "$num" \
       --json number,title,body,author,createdAt,updatedAt,state,labels,comments,url \
       --template "$TEMPLATE" > "$out" 2> "issues/${num}.err"; then
    rm -f "issues/${num}.err"
    done_count=$((done_count + 1))
  else
    fail_count=$((fail_count + 1))
    echo "FAIL $num: $(cat issues/${num}.err)" >&2
  fi
  if [ $((done_count % 20)) -eq 0 ]; then
    echo "Progress: $done_count/$total done, $fail_count failed"
  fi
done

echo "Done: $done_count/$total ($fail_count failed)"

# Stamp the directory with the time of the last successful fetch.
# Other agents read issues/LAST-FETCHED to decide whether the snapshot
# is fresh enough to act on.
{
  echo "last-fetched: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "source: endojs/endo (issues, state=open)"
  echo "files: $done_count (failed=$fail_count)"
  echo "script: scripts/fetch-issues.sh"
} > issues/LAST-FETCHED
