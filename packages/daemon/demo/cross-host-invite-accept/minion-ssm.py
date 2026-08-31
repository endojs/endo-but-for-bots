#!/usr/bin/env python3
# Run one shell command on the minion.town EC2 host via AWS SSM and print its
# stdout/stderr. A boto3 alternative to demo/minion-town/ssm.sh for environments
# that carry AWS credentials (~/.aws) but no `aws` CLI binary — e.g. the garden
# container, where the CLI is absent but `pip install --user boto3` works and
# /tmp is noexec (which breaks native yarn builds; redirect TMPDIR to an exec
# mount for `yarn install`, but NOT for running the daemon — its unix socket
# must stay on a short path like /tmp).
#
# Usage:  python3 minion-ssm.py '<shell command>' [timeout_seconds]
# Env:    MINION_INSTANCE_ID (default i-0380cd68b90020fad), AWS region us-west-1.
import os, sys, time, boto3

INSTANCE = os.environ.get('MINION_INSTANCE_ID', 'i-0380cd68b90020fad')
REGION = os.environ.get('AWS_REGION', 'us-west-1')
cmd = sys.argv[1]
timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 240

ssm = boto3.client('ssm', region_name=REGION)
r = ssm.send_command(
    InstanceIds=[INSTANCE],
    DocumentName='AWS-RunShellScript',
    Parameters={'commands': [cmd], 'executionTimeout': [str(timeout)]},
)
cid = r['Command']['CommandId']
status = 'Pending'
inv = {}
for _ in range(int(timeout / 2) + 10):
    time.sleep(2)
    try:
        inv = ssm.get_command_invocation(CommandId=cid, InstanceId=INSTANCE)
    except Exception:
        continue
    status = inv['Status']
    if status in ('Success', 'Failed', 'Cancelled', 'TimedOut'):
        break
print(f'### STATUS: {status} (cmd {cid})')
print('### STDOUT:')
print(inv.get('StandardOutputContent', ''))
print('### STDERR:')
print(inv.get('StandardErrorContent', ''))
sys.exit(0 if status == 'Success' else 1)
