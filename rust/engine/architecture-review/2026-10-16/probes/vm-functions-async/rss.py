import resource, subprocess, sys, time
# usage: python3 -I rss.py <js file>  -- runs ironhorse-xst on lib.js+file, reports max RSS and wall time
P = sys.argv[0].rsplit('/', 1)[0]
src = open(P + '/lib.js').read() + open(sys.argv[1]).read()
tmp = P + '/.rss_tmp.js'
open(tmp, 'w').write(src)
t = time.time()
r = subprocess.run(['/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst', '-s', tmp], capture_output=True, text=True)
dt = time.time() - t
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
print('stderr:', r.stderr.strip()[:300], '| exit', r.returncode, '| maxrss MiB %.1f' % (ru.ru_maxrss / 1024), '| wall %.2fs' % dt)
