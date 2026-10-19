#!/usr/bin/env python3
"""Build isolated experimental VM detail instrumentation; restore every patched source."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
parser.add_argument('--target-dir', required=True, type=Path,
                    help='separate Cargo output directory; never the normal target')
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
target = args.target_dir.resolve()
if target.is_relative_to((root/'target').resolve()):
    raise SystemExit('Use a separate temporary Cargo target directory')
patch = Path(__file__).with_name('mail-vm-detail-worker.patch')
subprocess.run(['git','apply','--check',str(patch)],cwd=root,check=True)
# Patch headers enumerate both tracked sources and the new timing-only module.
paths = [root/line[6:] for line in patch.read_text().splitlines() if line.startswith('+++ b/')]
original = {path:path.read_bytes() if path.exists() else None for path in paths}
try:
    subprocess.run(['git','apply',str(patch)],cwd=root,check=True)
    subprocess.run(['cargo','build','--offline','--release','-p','thixotrope-ironhorse-worker'],
                   cwd=root,env={**os.environ,'CARGO_TARGET_DIR':str(target)},check=True)
    output=args.output.resolve()
    if output == (root/'target/release/thixotrope-ironhorse-worker').resolve():
        raise SystemExit('Choose an experimental output path')
    shutil.copy2(target/'release/thixotrope-ironhorse-worker',output)
    print(json.dumps({'binary':str(output),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
                      'detailEnv':'THIX_MAIL_VM_DETAIL=1','patchSha256':hashlib.sha256(patch.read_bytes()).hexdigest()}))
finally:
    for path,content in original.items():
        if content is None:path.unlink(missing_ok=True)
        else:path.write_bytes(content)
