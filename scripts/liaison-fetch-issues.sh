#!/usr/bin/env bash
# Fetch fresh open-issue snapshot for the liaison.
# Output: JSON array of issues with comments inlined, sorted by updatedAt desc.
# Used by roles/liaison.md as the inbound step.

set -euo pipefail

REPO="${REPO:-endojs/endo-but-for-bots}"
LIMIT="${LIMIT:-200}"

gh issue list -R "$REPO" --state open --limit "$LIMIT" \
  --json number,title,author,updatedAt,comments,labels,state,body
