#!/usr/bin/env bash
# Run a shell command on minion.town via SSM, wait, print stdout+stderr.
# Usage: ssm.sh 'command string'   [runas-user, default ssm default]
set -euo pipefail
export HOME="${GARDEN_AWS_HOME:-$HOME}" AWS_PAGER=""
INSTANCE="${MINION_INSTANCE_ID:-i-0380cd68b90020fad}"
REGION=us-west-1
CMD="$1"
CID=$(aws ssm send-command \
  --region "$REGION" \
  --instance-ids "$INSTANCE" \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$CMD")]" \
  --query "Command.CommandId" --output text)
# poll
for i in $(seq 1 120); do
  STATUS=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$INSTANCE" --query "Status" --output text 2>/dev/null || echo Pending)
  case "$STATUS" in
    Success|Failed|Cancelled|TimedOut) break;;
  esac
  sleep 2
done
echo "### STATUS: $STATUS (cmd $CID)"
echo "### STDOUT:"
aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$INSTANCE" --query "StandardOutputContent" --output text
echo "### STDERR:"
aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$INSTANCE" --query "StandardErrorContent" --output text
