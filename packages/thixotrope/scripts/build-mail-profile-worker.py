#!/usr/bin/env python3
"""Build a temporary timing-only worker, restoring normal source and binary."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
source = root / 'rust/thixotrope-ironhorse-worker/src/main.rs'
binary = root / 'target/release/thixotrope-ironhorse-worker'
patch = Path(__file__).with_name('mail-profile-worker.patch')
subprocess.run(['git', 'diff', '--exit-code', '--', str(source)], cwd=root, check=True)
subprocess.run(['git', 'apply', '--check', '--unidiff-zero', str(patch)], cwd=root, check=True)
output = args.output.resolve()
if output == binary.resolve():
    raise SystemExit('Choose a separate output path, not the normal release binary')
original_source = source.read_bytes()
if hashlib.sha256(original_source).hexdigest() != 'ee3633e28d09b58f0b9ca1d076f1e7e0190db7596120d002d22806ff76a48a91':
    raise SystemExit('Worker source changed; refresh the timing patch before rebuilding')
original_binary = binary.read_bytes()
mode = binary.stat().st_mode
try:
    subprocess.run(['git', 'apply', '--unidiff-zero', str(patch)], cwd=root, check=True)
    subprocess.run(['cargo', 'build', '--offline', '--release', '-p',
                    'thixotrope-ironhorse-worker'], cwd=root, check=True)
    shutil.copy2(binary, output)
    print(json.dumps({'profileBinary': str(output),
                      'originalSha256': hashlib.sha256(original_binary).hexdigest(),
                      'profileSha256': hashlib.sha256(output.read_bytes()).hexdigest()}))
finally:
    source.write_bytes(original_source)
    binary.write_bytes(original_binary)
    binary.chmod(mode)
    assert hashlib.sha256(binary.read_bytes()).digest() == hashlib.sha256(original_binary).digest()
