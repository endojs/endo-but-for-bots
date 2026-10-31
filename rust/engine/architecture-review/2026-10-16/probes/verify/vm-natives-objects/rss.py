import resource, subprocess, sys, time
t=time.time()
p=subprocess.run(["/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst", sys.argv[1]],capture_output=True,text=True,timeout=600)
dt=time.time()-t
ru=resource.getrusage(resource.RUSAGE_CHILDREN)
print((p.stdout+p.stderr).strip().splitlines()[-1:] , "exit", p.returncode, "wall %.2fs maxrss %.1f MB" % (dt, ru.ru_maxrss/1024))
