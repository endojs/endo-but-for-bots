# usage: python3 -I timed.py <vmem-limit-MiB|0> file.js -> exit status/signal, wall, maxrss, stderr tail
import resource, subprocess, sys, time
lim = int(sys.argv[1])
def pre():
    if lim:
        resource.setrlimit(resource.RLIMIT_AS, (lim << 20, lim << 20))
t = time.time()
p = subprocess.run(["/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst", sys.argv[2]], capture_output=True, text=True, timeout=1200, preexec_fn=pre)
dt = time.time() - t
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
print(sys.argv[2], "returncode", p.returncode, "wall %.2fs maxrss %.1f MiB" % (dt, ru.ru_maxrss / 1024), "stderr:", (p.stderr or '').strip()[-300:])
