# usage: python3 extract.py file.js 'JSON.stringify(log)'
# Reads a string out of ironhorse-xst after all jobs settle, by binary search on
# a deliberate StackOverflow halt (ironhorse-xst does not surface job errors).
import subprocess, sys, os
body = open(sys.argv[1]).read()
expr = sys.argv[2]
XST = '/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst'
tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bis', 'x_%d.js' % os.getpid())
def test(cond):
    src = body + "\nfunction finish() { var S = String(" + expr + "); if (!(" + cond + ")) { (function r() { r(); })(); } }\nvar chain = Promise.resolve(); for (var i = 0; i < 60; i++) chain = chain.then(function () {}); chain.then(finish);\n"
    open(tmp, 'w').write(src)
    return subprocess.run([XST, tmp], capture_output=True).returncode == 0
lo, hi = 0, 4096
while lo < hi:
    m = (lo + hi) // 2
    if test("S.length <= %d" % m): hi = m
    else: lo = m + 1
n = lo; s = ''
for i in range(n):
    lo, hi = 0, 127
    while lo < hi:
        m = (lo + hi) // 2
        if test("S.charCodeAt(%d) <= %d" % (i, m)): hi = m
        else: lo = m + 1
    s += chr(lo)
os.remove(tmp)
print(s)
