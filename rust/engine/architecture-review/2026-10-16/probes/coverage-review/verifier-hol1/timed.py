import resource,subprocess,sys,time
lim=int(sys.argv[1])*1024*1024
def pre(): resource.setrlimit(resource.RLIMIT_AS,(lim,lim))
t=time.time()
p=subprocess.run(['/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst',sys.argv[2]],stdout=subprocess.PIPE,stderr=subprocess.PIPE,preexec_fn=pre,timeout=120)
ru=resource.getrusage(resource.RUSAGE_CHILDREN)
print(sys.argv[2],'rc',p.returncode,'%.2fs'%(time.time()-t),'maxrss %.1fMiB'%(ru.ru_maxrss/1024),'stdout',len(p.stdout),'stderr',len(p.stderr),p.stderr[-120:])
