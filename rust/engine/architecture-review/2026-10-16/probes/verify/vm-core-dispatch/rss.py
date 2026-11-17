import subprocess,sys,resource,time
t=time.time()
p=subprocess.run(['/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst',sys.argv[1]],capture_output=True,text=True)
print("out:",(p.stdout+p.stderr).strip().splitlines()[-1:],"rc",p.returncode,"maxrss_kb",resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,"wall",round(time.time()-t,2))
