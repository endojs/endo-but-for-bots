import resource, subprocess, sys, time
t = time.time()
p = subprocess.run(sys.argv[1:], capture_output=True, text=True)
e = time.time() - t
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
print(f"rc={p.returncode} maxrss={ru.ru_maxrss/1024:.1f}MB elapsed={e:.2f}s stderr={p.stderr.strip()[:150]}")
