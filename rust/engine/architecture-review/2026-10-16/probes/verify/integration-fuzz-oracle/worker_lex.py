import json, os, subprocess, sys, tempfile
worker = sys.argv[1]
d = tempfile.mkdtemp(prefix="int-verify-")
p = subprocess.Popen([worker, os.path.join(d, "heap.sqlite"), "audit-profile", os.path.join(d, "active.lock")],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
p.stdout.readline()
for src in ["let lex = 5; 'ok'", "String(lex)"]:
    p.stdin.write(json.dumps({"op": "eval", "source": src, "budget": 100_000_000}) + "\n"); p.stdin.flush()
    print(f"  {src!r} -> {p.stdout.readline().strip()}")
p.stdin.write('{"op":"close"}\n'); p.stdin.flush(); p.wait()
