import subprocess,sys
body=open(sys.argv[1]).read()
expr=sys.argv[2]  # JS expression yielding a string, evaluated in finish()
XST='/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst'
def test(cond):
    src=body+"\nfunction finish() { var S = String("+expr+"); if (!("+cond+")) { (function r() { r(); })(); } }\nvar chain = Promise.resolve(); for (var i = 0; i < 60; i++) chain = chain.then(function () {}); chain.then(finish);\n"
    open('bis/x.js','w').write(src)
    return subprocess.run([XST,'bis/x.js'],capture_output=True).returncode==0
lo,hi=0,4096
while lo<hi:
    m=(lo+hi)//2
    if test("S.length <= %d"%m): hi=m
    else: lo=m+1
n=lo
s=''
for i in range(n):
    lo,hi=0,65535
    while lo<hi:
        m=(lo+hi)//2
        if test("S.charCodeAt(%d) <= %d"%(i,m)): hi=m
        else: lo=m+1
    s+=chr(lo)
print(s)
