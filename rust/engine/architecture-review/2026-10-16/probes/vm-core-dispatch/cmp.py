import json,re,sys,subprocess
f=sys.argv[1]
t=subprocess.run(['./run.sh',f],capture_output=True,text=True).stdout
lines=t.split('\n')
ih='\n'.join(l for l in lines if not l.startswith('NODE:'))
nd=[l for l in lines if l.startswith('NODE:')][0]
def parse(s):
    m=re.search(r'Error: (\[.*\])',s)
    return json.loads(m.group(1)) if m else None
a=parse(ih); b=parse(nd)
if a is None or b is None:
    print(t)
else:
    n=0
    for x,y in zip(a,b):
        if x!=y: print("DIFF", x, "| node:", y); n+=1
    print("checks", len(a),len(b), "diffs", n)
