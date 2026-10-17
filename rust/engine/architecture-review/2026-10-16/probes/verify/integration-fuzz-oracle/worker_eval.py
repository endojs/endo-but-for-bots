# Drive the real thixotrope-ironhorse-worker over NDJSON: direct eval context, and the crank goal.
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
        print(f"  {src!r}\n    -> {line}")
        if '"fatal"' in line or not line:
            p.wait(); return
    p.stdin.write('{"op":"close"}\n'); p.stdin.flush(); p.wait()
for src in ["class B { get x() { return 42; } } class C extends B { m() { return eval('super.x'); } } String(new C().m())",
            "var r; function F() { r = eval('new.target') === F; } new F(); String(r)",
            "class P { #x = 7; m() { return eval('this.#x'); } } String(new P().m())"]:
    session([src])
print("goal:")
session(["'use strict'; var counter = 41; function inc() { return ++counter; } 'defined'", "inc()"])
session(["'use strict'; var g = 1; typeof globalThis.g"])
