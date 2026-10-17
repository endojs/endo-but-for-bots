# AUDIT PROBE: drive the real thixotrope-ironhorse-worker binary over its
# NDJSON protocol. Each crank allocates ~200k slots of garbage that is
# unreachable once the crank completes. The worker never collects, so does
# the garbage accumulate, get checkpointed, and survive a worker restart?
import json, os, subprocess, sys, tempfile

worker = sys.argv[1]
d = tempfile.mkdtemp(prefix="int-worker-")
heap = os.path.join(d, "heap.sqlite")
lease = os.path.join(d, "active.lock")
GARBAGE = ("var keep = 0; for (var i = 0; i < 50000; i++) "
           "{ var o = { a: i, b: [i] }; keep = keep + 1; } keep")


def session(label, sources):
    p = subprocess.Popen([worker, heap, "audit-profile", lease],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True)
    print(f"[{label}] start: {p.stdout.readline().strip()}")
    for n, src in enumerate(sources, 1):
        p.stdin.write(json.dumps({"op": "eval", "source": src,
                                  "budget": 2_000_000_000}) + "\n")
        p.stdin.flush()
        line = p.stdout.readline().strip()
        print(f"[{label}] crank {n} ({src[:28]}...): {line}")
        if '"fatal"' in line or not line:
            p.wait()
            print(f"[{label}] worker exited {p.returncode}")
            return
    p.stdin.write(json.dumps({"op": "close"}) + "\n")
    p.stdin.flush()
    p.wait()
    print(f"[{label}] closed, exit {p.returncode}")


session("session 1", [GARBAGE] * 8)
print(f"heap file size after session 1: {os.path.getsize(heap)} bytes")
session("session 2 (restart)", ["'tiny crank'", GARBAGE])
session("session 3 (restart)", ["var s = 0; for (var i = 0; i < 30000; i++) s += [i].length; s"])
