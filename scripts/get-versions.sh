#!/bin/bash
set -ueo pipefail

# Gather a map of the versions from this or another workspace.
WORKDIR=${1:-.}

cd -- "$WORKDIR"
printf '%s\n' packages/*/package.json |
xargs jq '{key: .name, value: "^\(.version)"}' |
jq --slurp from_entries
