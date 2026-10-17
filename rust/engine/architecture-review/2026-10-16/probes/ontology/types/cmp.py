import json, subprocess, sys, re
XST='/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst'
NODE='/opt/node22/bin/node'
def run_xst(f):
    p = subprocess.run([XST, f], capture_output=True, text=True, errors='replace', timeout=60)
    return p.returncode, p.stdout, p.stderr
def run_node(f):
    src = open(f, encoding='utf-8').read()
    wrapper = "try{ require('vm').runInThisContext(require('fs').readFileSync(%r,'utf8')) } catch(e){ process.stderr.write(e.name+': '+e.message+'\\n'); process.exit(1) }" % f
    p = subprocess.run([NODE, '-e', wrapper], capture_output=True, text=True, errors='replace', timeout=60)
    return p.returncode, p.stdout, p.stderr
def parse(err):
    m = re.search(r'Error: (\{.*\})', err, re.S)
    if not m: return None
    try: return json.loads(m.group(1))
    except Exception as e: return None
f = sys.argv[1]
xc, xo, xe = run_xst(f)
nc, no, ne = run_node(f)
xj, nj = parse(xe), parse(ne)
if xj is None or nj is None:
    print('XST', xc, xo, xe[:3000]); print('NODE', nc, no, ne[:3000]); sys.exit()
for k in nj:
    a, b = xj.get(k, '<missing>'), nj[k]
    mark = '  ' if a == b else '!!'
    print(f"{mark} {k}: xst={a!r}" + ("" if a == b else f"  node={b!r}"))
