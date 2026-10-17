import sys, subprocess, time, resource, os
# usage: meas.py file.js [...]  -> wall seconds, maxrss MB, exit, stderr first line
for f in sys.argv[1:]:
    t0 = time.time()
    p = subprocess.Popen(['/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst', f], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = p.communicate(timeout=600)
    t1 = time.time()
    ru = resource.getrusage(resource.RUSAGE_CHILDREN)
    print(f"{os.path.basename(f)}: {t1-t0:.2f}s maxrss(cum)={ru.ru_maxrss/1024:.1f}MB exit={p.returncode} {err.decode()[:200].strip()}")
