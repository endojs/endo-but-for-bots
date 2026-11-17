import resource, subprocess, sys, time
t=time.time()
p=subprocess.run(sys.argv[1:], capture_output=True, text=True)
ru=resource.getrusage(resource.RUSAGE_CHILDREN)
print("out:", (p.stdout+p.stderr).strip()[:200], "| maxrss_MB=%.1f wall=%.2fs" % (ru.ru_maxrss/1024, time.time()-t))
