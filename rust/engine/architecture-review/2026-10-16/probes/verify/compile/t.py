import resource, subprocess, sys, time
for f in sys.argv[2:]:
    t = time.time()
    p = subprocess.run([sys.argv[1], f], capture_output=True, text=True)
    print(f"{f}: rc={p.returncode} wall={time.time()-t:.3f}s stderr={p.stderr.strip()[:120]}")
