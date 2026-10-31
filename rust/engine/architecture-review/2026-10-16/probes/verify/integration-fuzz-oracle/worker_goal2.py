import json, os, subprocess, sys, tempfile
worker = sys.argv[1]
def session(sources):
    d = tempfile.mkdtemp(prefix="int-verify-")
    p = subprocess.Popen([worker, os.path.join(d, "heap.sqlite"), "audit-profile", os.path.join(d, "active.lock")],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    p.stdout.readline()
    for src in sources:
        p.stdin.write(json.dumps({"op": "eval", "source": src, "budget": 100_000_000}) + "\n"); p.stdin.flush()
        line = p.stdout.readline().strip()
        print(f"  {src!r} -> {line[:160]}")
        if '"fatal"' in line: p.wait(); return
    p.stdin.write('{"op":"close"}\n'); p.stdin.flush(); p.wait()
session(["'use strict'; undeclared1 = 1; 'ok'"])
session(["'use strict'; function h() { return 1; } 'ok'", "typeof h"])
