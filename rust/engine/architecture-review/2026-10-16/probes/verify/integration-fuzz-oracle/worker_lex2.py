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
        m = line if len(line) < 120 else line[:40] + ' ... ' + line[-70:]
        print(f"  {src!r} -> {m}")
        if '"fatal"' in line: p.wait(); return
    p.stdin.write('{"op":"close"}\n'); p.stdin.flush(); p.wait()
session(["let lex = 5; function rd() { return lex; } String(lex)", "String(rd())", "typeof lex"])
